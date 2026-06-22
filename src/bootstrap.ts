import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixPath from 'fix-path';

/** Resolve the real `claude` binary (a shell *function* shadows it interactively). */
export function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
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
 * Apply environment fixups required before any `claude` process is spawned.
 * Apps launched from Finder get a minimal PATH (no Homebrew/nvm/~/.local/bin),
 * so restore the user's login-shell PATH, then pin the resolved binary into
 * CLAUDE_BIN so downstream spawns don't re-resolve it.
 */
export function setupEnvironment(): void {
  fixPath();
  process.env.CLAUDE_BIN = resolveClaudeBin();
}
