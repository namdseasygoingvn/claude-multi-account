import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountConfig } from './types.js';
import { getDataRoot } from './paths.js';

// Resolved at call time (not module load) so a packaged build can redirect the
// data root to userData via setDataRoot() before the first registry access.
function accountsDir(): string {
  return path.join(getDataRoot(), 'accounts');
}
function registryFile(): string {
  return path.join(getDataRoot(), 'accounts.json');
}

const LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;

export function isValidLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

export function loadRegistry(): AccountConfig[] {
  try {
    const data = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    if (Array.isArray(data)) {
      return data.filter(
        (a): a is AccountConfig => a && typeof a.label === 'string' && typeof a.configDir === 'string',
      );
    }
  } catch {
    /* no registry yet */
  }
  return [];
}

export function saveRegistry(accounts: AccountConfig[]): void {
  fs.mkdirSync(getDataRoot(), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify(accounts, null, 2) + '\n');
}

export function getAccount(label: string): AccountConfig | undefined {
  return loadRegistry().find((a) => a.label === label);
}

/** Random, filesystem-safe internal handle for an account (UI shows the email, not this). */
function randomLabel(): string {
  return 'acct-' + crypto.randomBytes(4).toString('hex');
}

/** Pass a label to use it, or omit to auto-generate a random one. */
export function addAccount(label?: string, configDir?: string): AccountConfig {
  const accounts = loadRegistry();
  let finalLabel: string;
  if (label && label.length > 0) {
    if (!isValidLabel(label)) {
      throw new Error('label must be 1–32 chars: letters, digits, dot, dash, underscore');
    }
    if (accounts.some((a) => a.label === label)) {
      throw new Error(`account "${label}" already exists`);
    }
    finalLabel = label;
  } else {
    do {
      finalLabel = randomLabel();
    } while (accounts.some((a) => a.label === finalLabel));
  }
  const dir = configDir ?? path.join(accountsDir(), finalLabel);
  fs.mkdirSync(dir, { recursive: true });
  ensureOnboarded(dir); // skip claude's first-run wizard so login lands in the REPL
  const acc: AccountConfig = { label: finalLabel, configDir: dir };
  accounts.push(acc);
  saveRegistry(accounts);
  return acc;
}

/**
 * Drop an account from the registry. Deletes its on-disk config dir only when
 * it's tool-managed (under ACCOUNTS_DIR) — never the machine-default ~/.claude
 * or an externally-pointed dir, which we only un-register. Returns false if no
 * such account. The keychain credential entry is left for claude to manage.
 */
export function removeAccount(label: string): boolean {
  const accounts = loadRegistry();
  const acc = accounts.find((a) => a.label === label);
  if (!acc) return false;
  saveRegistry(accounts.filter((a) => a.label !== label));
  const resolved = path.resolve(acc.configDir);
  const managed = resolved.startsWith(path.resolve(accountsDir()) + path.sep);
  if (managed && resolved !== path.join(os.homedir(), '.claude')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  return true;
}

/**
 * Persist a new account order. `orderedLabels` lists labels in the desired order
 * (the renderer's drag-to-reorder result); accounts are rewritten to match it.
 * Unknown labels are ignored and any registered account missing from the list is
 * appended in its original relative order, so a concurrent add can't be dropped.
 */
export function reorderAccounts(orderedLabels: string[]): AccountConfig[] {
  const accounts = loadRegistry();
  const byLabel = new Map(accounts.map((a) => [a.label, a]));
  const next: AccountConfig[] = [];
  for (const label of orderedLabels) {
    const acc = byLabel.get(label);
    if (acc && !next.includes(acc)) next.push(acc);
  }
  for (const acc of accounts) if (!next.includes(acc)) next.push(acc);
  saveRegistry(next);
  return next;
}

/** Empty directory used as cwd for spawned claude REPLs, so no real project gets touched. */
export function scratchDir(): string {
  const dir = path.join(getDataRoot(), '.scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Claude Code re-runs its first-run onboarding (theme picker, then the "Select
 * login method" screen) on every launch until `hasCompletedOnboarding` is true
 * in the config dir's `.claude.json`. While it does, it IGNORES a valid token
 * already in the keychain and loops back to the login picker — so a
 * freshly-authenticated account stays stuck "logged in but never usable" if its
 * login session was killed before reaching the REPL. Seed the flag so claude
 * trusts the persisted token and drops straight into the REPL. Idempotent;
 * never touches the machine-default ~/.claude (the user's real config).
 */
export function ensureOnboarded(configDir: string): void {
  if (path.resolve(configDir) === path.join(os.homedir(), '.claude')) return;
  const file = path.join(configDir, '.claude.json');
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* no state file yet — start fresh */
  }
  if (cfg.hasCompletedOnboarding === true) return;
  cfg.hasCompletedOnboarding = true;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

export interface LoginProbe {
  exists: boolean;
  loggedIn: boolean;
  email: string | null;
}

/**
 * Heuristic login probe: after a successful login, Claude Code's state file
 * carries an `oauthAccount` block (metadata only — the actual token lives in
 * the OS keychain or the config dir's credentials file, which we never read).
 * With CLAUDE_CONFIG_DIR set the state file is `<configDir>/.claude.json`;
 * the default `~/.claude` keeps it as the sibling `~/.claude.json`, so both
 * locations are checked — that lets users register their existing main
 * account by pointing a label at `~/.claude`.
 */
export function probeLogin(acc: AccountConfig): LoginProbe {
  const exists = fs.existsSync(acc.configDir);
  let loggedIn = false;
  let email: string | null = null;
  const candidates = [path.join(acc.configDir, '.claude.json'), acc.configDir.replace(/\/+$/, '') + '.json'];
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg && typeof cfg === 'object' && cfg.oauthAccount) {
        loggedIn = true;
        email = typeof cfg.oauthAccount.emailAddress === 'string' ? cfg.oauthAccount.emailAddress : null;
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  return { exists, loggedIn, email };
}
