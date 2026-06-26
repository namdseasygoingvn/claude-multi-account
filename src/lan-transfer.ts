import fs from 'node:fs';
import path from 'node:path';

import { addAccount, getAccount, loadRegistry, probeLogin, removeAccount } from './registry.js';
import { readSecret, serviceForConfigDir, writeSecret } from './keychain.js';
import type { AccountConfig } from './types.js';

// The contract shared by the lend server and the receive client: the wire
// payload for one signed-in account, plus reading an account into it and
// applying a received one back out. Node-pure (registry + keychain only) so it
// stays testable and OS-agnostic — the credential blob is identical JSON on
// macOS and Windows; keychain.ts handles where each side stores it.

/** Marker inside the receiver's PIN-proof, so any decryptable blob isn't enough. */
export const PROOF_MARKER = 'claude-lan-sync-proof';

/** One signed-in account, portable across machines. */
export interface AccountTransfer {
  v: 1;
  /** Display email (metadata only). */
  email: string | null;
  /** The credential blob Claude Code stores (same JSON shape on every OS). */
  token: string;
  /** The `.claude.json` `oauthAccount` block, so the receiver shows the email + signed-in dot. */
  oauthAccount: unknown;
}

/** Read the `oauthAccount` metadata block from an account's state file. */
function readOauthAccount(acc: AccountConfig): unknown {
  const candidates = [
    path.join(acc.configDir, '.claude.json'),
    acc.configDir.replace(/[/\\]+$/, '') + '.json', // ~/.claude keeps it as the sibling ~/.claude.json
  ];
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg && typeof cfg === 'object' && cfg.oauthAccount) return cfg.oauthAccount;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Serialise a registered, signed-in account for transfer. Reads the OS-specific
 * credential (may prompt the macOS Keychain once for a Claude-created item).
 * Throws if the account is unknown or has no stored credential.
 */
export function serializeAccount(label: string): AccountTransfer {
  const acc = getAccount(label);
  if (!acc) throw new Error(`unknown account "${label}"`);
  const token = readSecret(serviceForConfigDir(acc.configDir));
  if (token == null) {
    throw new Error('no stored credential for this account — sign it in before lending it');
  }
  return { v: 1, email: probeLogin(acc).email, token, oauthAccount: readOauthAccount(acc) };
}

/** Seed a fresh config dir's `.claude.json` with the transferred login metadata. */
function seedClaudeState(configDir: string, oauthAccount: unknown): void {
  const file = path.join(configDir, '.claude.json');
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* addAccount already created the dir + onboarding flag; start from whatever exists */
  }
  cfg.hasCompletedOnboarding = true; // trust the persisted token, skip the login picker
  if (oauthAccount) cfg.oauthAccount = oauthAccount;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Register a received transfer as a new local account: create its config dir,
 * store the credential in THIS machine's keystore, seed the state file. Rolls
 * back the registry entry if the credential write fails. Returns the new account.
 */
export function applyAccount(transfer: AccountTransfer, label?: string): AccountConfig {
  if (transfer?.v !== 1) throw new Error('unsupported transfer format');
  if (!transfer.token) throw new Error('transfer is missing its credential');
  const acc = addAccount(label);
  if (!writeSecret(serviceForConfigDir(acc.configDir), transfer.token)) {
    removeAccount(acc.label);
    throw new Error('failed to store the received credential on this machine');
  }
  seedClaudeState(acc.configDir, transfer.oauthAccount);
  return acc;
}

/** Outcome of applying a bundle: labels newly added + emails already present. */
export interface ApplyResult {
  added: string[];
  skipped: string[];
}

/**
 * Apply a bundle of transfers, skipping any whose email is already registered
 * here (so re-sharing to the same PC doesn't pile up duplicate cards). Returns
 * which labels were added and which emails were skipped.
 */
export function applyAccounts(transfers: AccountTransfer[]): ApplyResult {
  const seen = new Set(
    loadRegistry()
      .map((a) => probeLogin(a).email)
      .filter((e): e is string => !!e),
  );
  const result: ApplyResult = { added: [], skipped: [] };
  for (const t of transfers) {
    if (t.email && seen.has(t.email)) {
      result.skipped.push(t.email);
      continue;
    }
    result.added.push(applyAccount(t).label);
    if (t.email) seen.add(t.email);
  }
  return result;
}
