// [Open as new CLI] — open a new terminal/console window with CLAUDE_CONFIG_DIR
// pinned to one account, so any `claude` run in it uses that account, fully
// independent of the shared slot (this never touches the keychain or the slot).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry } from './registry.js';
import { ensureAccountsMigrated, emailForConfigDir } from './vscode-slot.js';

function shQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

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
  //
  // MUST be a detached, stdio:'ignore' async spawn — NOT spawnSync. The new
  // console is interactive (`cmd /k`) and inherits whatever stdio it's given, so
  // a piped/inherited spawnSync would block the Electron main process until the
  // user closes the terminal (the app freezes, then Electron kills it as hung).
  // Detached + ignored stdio + unref lets the window outlive us with no handles
  // held, so this returns immediately.
  const child = spawn('cmd.exe', ['/c', `start "" cmd /k "${file}"`], {
    env,
    windowsVerbatimArguments: true,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {}); // fire-and-forget: a spawn failure must not crash main
  child.unref();
}
