import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { scratchDir } from './registry.js';

export interface SpawnOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * True for the machine-default config dir (~/.claude). Setting
 * CLAUDE_CONFIG_DIR to that path is NOT equivalent to leaving it unset:
 * claude would then look for `.claude.json` inside the dir (the default
 * layout keeps it as the sibling `~/.claude.json`) and run first-time
 * onboarding against the user's real account dir.
 */
export function isDefaultConfigDir(configDir: string): boolean {
  return path.resolve(configDir) === path.join(os.homedir(), '.claude');
}

/**
 * Spawn a real `claude` REPL in a pseudo-terminal. `configDir` becomes that
 * process's CLAUDE_CONFIG_DIR, which is what isolates one account from
 * another; pass null (or the default ~/.claude) to use the machine default.
 */
export function spawnClaude(configDir: string | null, opts: SpawnOptions = {}): pty.IPty {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (configDir && !isDefaultConfigDir(configDir)) {
    env.CLAUDE_CONFIG_DIR = configDir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  // Credentials and routing must come from the account's own config dir —
  // never from whatever environment launched this server, which may itself
  // be a Claude Code session or a shell with API keys exported.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE;
  delete env.CLAUDE_EFFORT;
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  env.TERM = 'xterm-256color';

  // Windows: a `.cmd`/`.ps1` shim (how npm installs `claude`) can't be launched
  // directly through ConPTY — CreateProcess only runs real executables — so run
  // it via cmd.exe. A native `claude.exe` is spawned directly, as on Unix.
  const useCmd = process.platform === 'win32' && !/\.exe$/i.test(CLAUDE_BIN);
  const file = useCmd ? process.env.ComSpec || 'cmd.exe' : CLAUDE_BIN;
  const args = useCmd ? ['/c', CLAUDE_BIN] : [];

  return pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 40,
    cwd: opts.cwd ?? scratchDir(),
    env,
  });
}
