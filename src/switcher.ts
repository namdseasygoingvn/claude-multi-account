import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataRoot } from './paths.js';
import { loadRegistry, saveRegistry, ensureOnboarded } from './registry.js';

const HOME = os.homedir();
/** The shared slot's metadata file: the sibling of ~/.claude, not inside it. */
const SHARED_STATE_FILE = path.join(HOME, '.claude.json');
/** Command-palette shortcut to quote in "reload VS Code manually" messages. */
const RELOAD_SHORTCUT = process.platform === 'darwin' ? '⌘⇧P' : 'Ctrl+Shift+P';

// Re-derive these here to avoid a circular import surface; keep in sync with keychain.ts.
import { sharedSlotService, serviceForConfigDir, copySecret } from './keychain.js';

export interface SwitchResult {
  ok: boolean;
  email: string | null;
  reloaded: boolean;
  message: string;
}

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

function setActiveVSCodeLabel(label: string): void {
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
interface OAuthAccount {
  emailAddress?: string;
  [k: string]: unknown;
}

function stateFileForConfigDir(dir: string): string {
  if (path.resolve(dir) === path.join(HOME, '.claude')) return SHARED_STATE_FILE;
  return path.join(dir, '.claude.json');
}

function readOAuthAccount(jsonFile: string): OAuthAccount | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    return cfg && typeof cfg === 'object' && cfg.oauthAccount ? (cfg.oauthAccount as OAuthAccount) : null;
  } catch {
    return null;
  }
}

/** Merge ONLY the oauthAccount key into the target JSON; preserve all other
 *  keys; write atomically so the precious ~/.claude.json is never truncated. */
function writeOAuthAccount(jsonFile: string, oauthAccount: OAuthAccount): void {
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

function emailForConfigDir(dir: string): string | null {
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

// ── helpers ──────────────────────────────────────────────────────────────────
function shQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

// ── [Open as new CLI] ────────────────────────────────────────────────────────
/**
 * Open a new Terminal window with CLAUDE_CONFIG_DIR pinned to this account, so
 * any `claude` run in it uses that account — independent of the shared slot.
 * Writes a .command launcher and opens it (this does NOT touch the keychain or
 * the shared slot at all).
 */
export function openCli(label: string): void {
  ensureAccountsMigrated();
  const acc = loadRegistry().find((a) => a.label === label);
  if (!acc) throw new Error(`unknown account "${label}"`);
  const dir = acc.configDir;
  const email = emailForConfigDir(dir) ?? label;
  if (process.platform === 'win32') return openCliWindows(label, dir, email);
  // email/label get embedded in a shell script that is later executed, so treat
  // them as untrusted: assign via single-quoted (shQuote'd) vars and print them
  // with `print -r` (no escape/prompt expansion). Parameter expansion isn't
  // re-evaluated, so a value containing $(…), backticks, or %-codes can't run.
  const script =
    [
      '#!/bin/zsh',
      `export CLAUDE_CONFIG_DIR=${shQuote(dir)}`,
      // Mirror the app's spawn hygiene so an exported API key can't shadow OAuth.
      'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDECODE 2>/dev/null',
      `cqm_email=${shQuote(email)}`,
      `cqm_label=${shQuote(label)}`,
      'clear',
      'print -P -- "  %F{cyan}Claude CLI%f"',
      'print -r -- "  account: ${cqm_email}  [${cqm_label}]"',
      'print -r -- "  CLAUDE_CONFIG_DIR is set for this window. Start Claude with:  claude"',
      'print --',
      'exec "${SHELL:-/bin/zsh}" -il',
      '',
    ].join('\n');
  // Unique per invocation: `open` returns before Terminal finishes reading the
  // file, so a fixed name could be truncated by a second click mid-read.
  const file = path.join(os.tmpdir(), `claude-cli-${label}-${Date.now()}.command`);
  fs.writeFileSync(file, script, { mode: 0o755 });
  const r = spawnSync('/usr/bin/open', [file]);
  if (r.status !== 0) throw new Error('failed to open a Terminal window');
}

/**
 * Windows equivalent of openCli: open a NEW console window with
 * CLAUDE_CONFIG_DIR pinned to this account. The launcher script is STATIC — the
 * account dir + display strings travel as environment variables (set on the
 * child below), and the banner prints them via delayed expansion (`!VAR!`),
 * which never re-parses `& | %` etc. So an email/label containing shell
 * metacharacters can't inject commands (the macOS path relies on shQuote for
 * the same guarantee).
 */
function openCliWindows(label: string, dir: string, email: string): void {
  const script =
    [
      '@echo off',
      'setlocal EnableDelayedExpansion',
      'echo.',
      'echo   Claude CLI',
      'echo   account: !CQM_EMAIL!  [!CQM_LABEL!]',
      'echo   CLAUDE_CONFIG_DIR is set for this window. Start Claude with:  claude',
      'echo.',
      'endlocal',
      '',
    ].join('\r\n');
  const safe = label.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(os.tmpdir(), `claude-cli-${safe}-${Date.now()}.cmd`);
  fs.writeFileSync(file, script);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CLAUDE_CONFIG_DIR = dir;
  env.CQM_EMAIL = email;
  env.CQM_LABEL = label;
  // Mirror the app's spawn hygiene so an exported API key can't shadow OAuth.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE;

  // `start "" cmd /k "<script>"` opens a new window, runs the banner, and leaves
  // the shell interactive with the env above. windowsVerbatimArguments so cmd
  // sees the line exactly (start's empty title arg + the quoted script path).
  const r = spawnSync('cmd.exe', ['/c', `start "" cmd /k "${file}"`], {
    env,
    windowsVerbatimArguments: true,
  });
  if (r.status !== 0) throw new Error('failed to open a console window');
}

// ── [Switch VS Code] ──────────────────────────────────────────────────────────
/**
 * Render this account into the shared slot (keychain `Claude Code-credentials`
 * + ~/.claude.json oauthAccount) that the VS Code extension reads, then ask
 * VS Code to reload. Syncs the previously-active account back to its isolated
 * entry first so a token refresh that happened while it was live isn't lost.
 */
export function switchVSCode(label: string): SwitchResult {
  ensureAccountsMigrated();
  const accounts = loadRegistry();
  const target = accounts.find((a) => a.label === label);
  if (!target) throw new Error(`unknown account "${label}"`);

  const targetEmail = emailForConfigDir(target.configDir);
  const activeLabel = getActiveVSCodeLabel();

  if (activeLabel === label) {
    const reloaded = reloadVSCode();
    return {
      ok: true,
      email: targetEmail,
      reloaded,
      message: reloaded
        ? `${targetEmail ?? label} is already active in VS Code — reloaded.`
        : `${targetEmail ?? label} is already active in VS Code. Reload VS Code to apply.`,
    };
  }

  // 1) sync-back the currently-active account (best-effort)
  if (activeLabel) {
    const active = accounts.find((a) => a.label === activeLabel);
    if (active) {
      try {
        copySecret(sharedSlotService(), serviceForConfigDir(active.configDir));
        const liveOAuth = readOAuthAccount(SHARED_STATE_FILE);
        if (liveOAuth) writeOAuthAccount(stateFileForConfigDir(active.configDir), liveOAuth);
      } catch {
        /* a failed sync-back must not block the switch */
      }
    }
  }

  // 2) render the target into the shared slot. The TOKEN swap is the
  //    authoritative "active account" change, so record it the instant it
  //    succeeds — before the cosmetic metadata write, which must never leave
  //    switch-state.json disagreeing with the token actually in the slot (a
  //    mismatch would make the next switch sync the wrong account back).
  copySecret(serviceForConfigDir(target.configDir), sharedSlotService());
  setActiveVSCodeLabel(label);
  try {
    const targetOAuth = readOAuthAccount(stateFileForConfigDir(target.configDir));
    if (targetOAuth) writeOAuthAccount(SHARED_STATE_FILE, targetOAuth);
  } catch {
    /* metadata is cosmetic; the token swap already succeeded */
  }

  // 3) reload VS Code (best-effort)
  const reloaded = reloadVSCode();
  return {
    ok: true,
    email: targetEmail,
    reloaded,
    message: reloaded
      ? `VS Code switched to ${targetEmail ?? label} and reloaded.`
      : `VS Code switched to ${targetEmail ?? label}. Reload VS Code (${RELOAD_SHORTCUT} → "Reload Window") to apply.`,
  };
}

export function isVSCodeRunning(): boolean {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/NH'], { encoding: 'utf8' });
    return r.status === 0 && /Code\.exe/i.test(r.stdout);
  }
  return spawnSync('/usr/bin/pgrep', ['-f', 'Visual Studio Code']).status === 0;
}

/**
 * Best-effort: drive VS Code's Command Palette to run "Reload Window". Requires
 * macOS Accessibility permission to send keystrokes; returns false if VS Code
 * isn't running or osascript fails (the caller then tells the user to reload
 * manually). The credential swap has already succeeded by this point.
 */
function reloadVSCode(): boolean {
  if (!isVSCodeRunning()) return false;
  // Scripted reload drives the Command Palette via AppleScript/System Events —
  // macOS only. Elsewhere the caller tells the user to reload manually.
  if (process.platform !== 'darwin') return false;
  const lines = [
    'tell application "Visual Studio Code" to activate',
    'delay 0.4',
    'tell application "System Events"',
    '  keystroke "p" using {command down, shift down}',
    '  delay 0.4',
    '  keystroke "Reload Window"',
    '  delay 0.4',
    '  key code 36',
    'end tell',
  ];
  const args: string[] = [];
  for (const l of lines) args.push('-e', l);
  return spawnSync('/usr/bin/osascript', args, { encoding: 'utf8' }).status === 0;
}
