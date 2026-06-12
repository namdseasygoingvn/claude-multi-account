import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Works from both src/ (tsx) and dist/ (compiled) since each sits one level below the root. */
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const ACCOUNTS_DIR = path.join(PROJECT_ROOT, 'accounts');
export const SCRATCH_DIR = path.join(PROJECT_ROOT, '.scratch');
const REGISTRY_FILE = path.join(PROJECT_ROOT, 'accounts.json');

const LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;

export function isValidLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

export function loadRegistry(): AccountConfig[] {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
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
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(accounts, null, 2) + '\n');
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
  const dir = configDir ?? path.join(ACCOUNTS_DIR, finalLabel);
  fs.mkdirSync(dir, { recursive: true });
  const acc: AccountConfig = { label: finalLabel, configDir: dir };
  accounts.push(acc);
  saveRegistry(accounts);
  return acc;
}

/** Empty directory used as cwd for spawned claude REPLs, so no real project gets touched. */
export function scratchDir(): string {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  return SCRATCH_DIR;
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
