import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixPath from 'fix-path';

/** macOS/Linux: resolve `claude` (a shell *function* can shadow it interactively). */
function resolveClaudeUnix(): string {
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const out = execSync('command -v claude', { shell: '/bin/bash', encoding: 'utf8' }).trim();
    if (out) return out;
  } catch {
    /* fall through to bare name on PATH */
  }
  return 'claude';
}

/**
 * Windows: `claude` ships as a `.cmd`/`.ps1` shim (npm) or a `.exe` (native
 * installer). Prefer a concrete path; otherwise let `where` resolve it, and
 * fall back to the bare name (session/health wrap shims through cmd.exe).
 */
function resolveClaudeWindows(): string {
  const home = os.homedir();
  const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.cmd'),
    path.join(home, '.claude', 'local', 'claude.exe'),
    path.join(home, '.claude', 'local', 'claude.cmd'),
    path.join(appdata, 'npm', 'claude.cmd'),
    path.join(appdata, 'npm', 'claude.exe'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    // `where` prints one match per line in PATHEXT priority; take the first.
    const out = execSync('where claude', { encoding: 'utf8' }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first) return first;
  } catch {
    /* not on PATH */
  }
  return 'claude';
}

/** Resolve the real `claude` binary for the current platform. */
export function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  return process.platform === 'win32' ? resolveClaudeWindows() : resolveClaudeUnix();
}

/**
 * Apply environment fixups required before any `claude` process is spawned.
 * On macOS, apps launched from Finder get a minimal PATH (no Homebrew/nvm/
 * ~/.local/bin), so restore the user's login-shell PATH; on Windows GUI apps
 * already inherit the full system PATH, and `fix-path` is a POSIX shell shim,
 * so skip it. Then pin the resolved binary into CLAUDE_BIN so downstream spawns
 * don't re-resolve it.
 */
export function setupEnvironment(): void {
  if (process.platform !== 'win32') fixPath();
  process.env.CLAUDE_BIN = resolveClaudeBin();
}
