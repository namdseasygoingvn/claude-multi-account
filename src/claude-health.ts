// ── Claude CLI health check + self-repair ────────────────────────────────────
// The whole app works by driving the `claude` binary over PTYs. When that binary
// is broken (a truncated/unsigned update gets SIGKILL'd on launch — see the
// "claude-binary-truncation" episode) every login and usage check fails with a
// cryptic "exit 0". Rather than make the user diagnose that by hand, we probe
// the binary and offer a one-click reinstall of the latest version from npm.
import { spawn } from 'node:child_process';

export type HealthStatus = 'ok' | 'killed' | 'missing' | 'error';

export interface ClaudeHealth {
  ok: boolean;
  status: HealthStatus;
  version: string | null;
  /** Human-readable explanation, suitable for a dialog. */
  detail: string;
}

const VERSION_RE = /\b\d+\.\d+\.\d+\b/;
const NPM_SPEC = '@anthropic-ai/claude-code@latest';

function claudeBin(): string {
  return process.env.CLAUDE_BIN || 'claude';
}

/**
 * Run `claude --version` with a timeout and classify the outcome. A healthy
 * binary prints its version and exits 0; a corrupt/unsigned one is SIGKILL'd by
 * the kernel on Apple Silicon (signal SIGKILL / code 137) before printing.
 */
export function probeClaudeHealth(timeoutMs = 8000): Promise<ClaudeHealth> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (h: ClaudeHealth): void => {
      if (settled) return;
      settled = true;
      resolve(h);
    };

    let child;
    try {
      child = spawn(claudeBin(), ['--version'], { windowsHide: true });
    } catch (err) {
      done({ ok: false, status: 'error', version: null, detail: `couldn't launch claude: ${msg(err)}` });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done({ ok: false, status: 'error', version: null, detail: 'claude --version timed out' });
    }, timeoutMs);

    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        done({ ok: false, status: 'missing', version: null, detail: 'the claude binary was not found on your PATH' });
      } else {
        done({ ok: false, status: 'error', version: null, detail: msg(err) });
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL' || code === 137) {
        done({
          ok: false,
          status: 'killed',
          version: null,
          detail: 'the claude binary is corrupt (killed on launch — usually a truncated or unsigned update)',
        });
      } else if (code === 0) {
        const m = out.match(VERSION_RE);
        done({ ok: true, status: 'ok', version: m ? m[0] : out.trim() || null, detail: 'ok' });
      } else {
        done({ ok: false, status: 'error', version: null, detail: `claude --version exited with code ${code}` });
      }
    });
  });
}

export interface RepairResult {
  ok: boolean;
  health: ClaudeHealth;
  /** Set when the repair failed; ready to show to the user. */
  error: string | null;
}

/**
 * Force-reinstall the latest Claude Code from npm to repair a broken/outdated
 * binary, then re-probe. `onLine` receives npm's output lines for logging.
 * Success requires both a clean npm exit AND a healthy post-repair probe.
 */
export function repairClaude(onLine?: (line: string) => void): Promise<RepairResult> {
  return new Promise((resolve) => {
    const broken = (detail: string): ClaudeHealth => ({ ok: false, status: 'error', version: null, detail });
    let log = '';
    const sink = (chunk: unknown): void => {
      const s = String(chunk);
      log += s;
      if (onLine) for (const line of s.split('\n')) if (line.trim()) onLine(line.trim());
    };

    let child;
    try {
      child = spawn('npm', ['install', '-g', NPM_SPEC, '--force'], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, health: broken(''), error: `couldn't run npm: ${msg(err)}` });
      return;
    }

    child.stdout?.on('data', sink);
    child.stderr?.on('data', sink);
    child.on('error', (err: NodeJS.ErrnoException) => {
      const hint = err.code === 'ENOENT' ? 'npm was not found on your PATH' : msg(err);
      resolve({ ok: false, health: broken(hint), error: hint });
    });
    child.on('exit', async (code) => {
      const health = await probeClaudeHealth();
      if (code === 0 && health.ok) {
        resolve({ ok: true, health, error: null });
        return;
      }
      let error: string;
      if (/EACCES|permission denied/i.test(log)) {
        error = `npm needs elevated permissions here. Run this in Terminal:\n  sudo npm install -g ${NPM_SPEC} --force`;
      } else if (code !== 0) {
        error = `npm exited with code ${code}. Try this in Terminal:\n  npm install -g ${NPM_SPEC} --force`;
      } else {
        error = `Reinstall finished but claude still isn't runnable: ${health.detail}`;
      }
      resolve({ ok: false, health, error });
    });
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
