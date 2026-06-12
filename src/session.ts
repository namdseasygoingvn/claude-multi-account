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
  // This tool may itself be run from inside a Claude Code session; the child
  // REPL must not inherit the parent's session markers.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.TERM = 'xterm-256color';

  return pty.spawn(CLAUDE_BIN, [], {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 40,
    cwd: opts.cwd ?? scratchDir(),
    env,
  });
}
