// The "shared slot" the VS Code extension reads (keychain `Claude Code-credentials`
// + ~/.claude.json oauthAccount) and the bookkeeping around which account
// currently occupies it: active-account tracking, oauthAccount metadata I/O, and
// the one-time migration of a bare ~/.claude account into an isolated home.
// switcher.ts (the switch flow) and cli-launch.ts both build on this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataRoot } from './paths.js';
import { loadRegistry, saveRegistry, ensureOnboarded } from './registry.js';
import { sharedSlotService, serviceForConfigDir, copySecret } from './keychain.js';

export const HOME = os.homedir();
/** The shared slot's metadata file: the sibling of ~/.claude, not inside it. */
export const SHARED_STATE_FILE = path.join(HOME, '.claude.json');

// ── active VS Code account tracking ────────────────────────────────────────
function stateFile(): string {
  return path.join(getDataRoot(), 'switch-state.json');
}

export function getActiveVSCodeLabel(): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return typeof s?.activeVSCode === 'string' ? s.activeVSCode : null;
  } catch {
    return null;
  }
}

export function setActiveVSCodeLabel(label: string): void {
  let s: Record<string, unknown> = {};
  try {
    s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    /* fresh */
  }
  s.activeVSCode = label;
  fs.mkdirSync(getDataRoot(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n');
}

// ── oauthAccount metadata helpers ───────────────────────────────────────────
export interface OAuthAccount {
  emailAddress?: string;
  [k: string]: unknown;
}

export function stateFileForConfigDir(dir: string): string {
  if (path.resolve(dir) === path.join(HOME, '.claude')) return SHARED_STATE_FILE;
  return path.join(dir, '.claude.json');
}

export function readOAuthAccount(jsonFile: string): OAuthAccount | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    return cfg && typeof cfg === 'object' && cfg.oauthAccount ? (cfg.oauthAccount as OAuthAccount) : null;
  } catch {
    return null;
  }
}

/** Merge ONLY the oauthAccount key into the target JSON; preserve all other
 *  keys; write atomically so the precious ~/.claude.json is never truncated. */
export function writeOAuthAccount(jsonFile: string, oauthAccount: OAuthAccount): void {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch {
    /* file may not exist yet */
  }
  cfg.oauthAccount = oauthAccount;
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  const tmp = jsonFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, jsonFile);
}

export function emailForConfigDir(dir: string): string | null {
  return readOAuthAccount(stateFileForConfigDir(dir))?.emailAddress ?? null;
}

// ── one-time, non-destructive migration of a bare ~/.claude account ─────────
/**
 * If a registered account's configDir is the bare ~/.claude (the shared slot
 * itself), give it its own isolated home so it can be switched/opened like any
 * other account. Copies the CURRENT shared-slot token + oauthAccount into the
 * new location; leaves the shared slot fully intact. Idempotent; safe to call
 * before every switch/open.
 */
export function ensureAccountsMigrated(): void {
  const accounts = loadRegistry();
  for (const acc of accounts) {
    if (path.resolve(acc.configDir) !== path.join(HOME, '.claude')) continue;
    const newDir = path.join(getDataRoot(), 'accounts', acc.label);
    fs.mkdirSync(newDir, { recursive: true });
    // token: shared slot → this account's own isolated entry
    copySecret(sharedSlotService(), serviceForConfigDir(newDir));
    // metadata: ~/.claude.json oauthAccount → <newDir>/.claude.json
    const oauth = readOAuthAccount(SHARED_STATE_FILE);
    if (oauth) writeOAuthAccount(path.join(newDir, '.claude.json'), oauth);
    ensureOnboarded(newDir);
    acc.configDir = newDir; // registry now points at the isolated home
    // Persist each account's migration immediately. If a later account in this
    // loop throws (e.g. a denied Keychain read), the work already done isn't
    // lost — and re-running won't re-copy an already-migrated account out of a
    // shared slot that may have changed in the meantime.
    saveRegistry(accounts);
    if (!getActiveVSCodeLabel()) setActiveVSCodeLabel(acc.label); // shared slot currently holds it
  }
}
