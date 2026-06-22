// [Switch VS Code] — render an account into the shared slot the VS Code
// extension reads, then ask VS Code to reload. The slot bookkeeping (active-
// account tracking, oauthAccount metadata, migration) lives in vscode-slot.ts;
// opening a standalone CLI window lives in cli-launch.ts. This file is the
// switch flow plus the VS Code reload helpers.
import { spawnSync } from 'node:child_process';
import { loadRegistry } from './registry.js';
import { sharedSlotService, serviceForConfigDir, copySecret } from './keychain.js';
import {
  SHARED_STATE_FILE,
  ensureAccountsMigrated,
  emailForConfigDir,
  getActiveVSCodeLabel,
  readOAuthAccount,
  setActiveVSCodeLabel,
  stateFileForConfigDir,
  writeOAuthAccount,
} from './vscode-slot.js';

// Preserve the historical import surface: callers still reach getActiveVSCodeLabel
// and openCli through switcher.js.
export { getActiveVSCodeLabel } from './vscode-slot.js';
export { openCli } from './cli-launch.js';

/** Command-palette shortcut to quote in "reload VS Code manually" messages. */
const RELOAD_SHORTCUT = process.platform === 'darwin' ? '⌘⇧P' : 'Ctrl+Shift+P';

export interface SwitchResult {
  ok: boolean;
  email: string | null;
  reloaded: boolean;
  message: string;
}

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
