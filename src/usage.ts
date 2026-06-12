import type { AccountConfig, UsageResult, UsageRun } from './types.js';
import { spawnClaude } from './session.js';
import { cleanCapture, parseUsage, looksLoggedOut } from './parse.js';

const READY_TIMEOUT_MS = 25_000;
/** Hard cap on how long we wait for the /usage panel after sending the command. */
const PANEL_CAP_MS = 30_000;
/** Panel considered fully rendered once output has been idle this long… */
const PANEL_IDLE_MS = 800;
/** …but never declare done before this much time has passed (panel data loads async). */
const PANEL_MIN_MS = 2_000;
const RAW_TAIL_CHARS = 8_000;

export interface UsageEvents {
  onPhase?: (phase: string) => void;
  onData?: (chunk: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ephemeral usage check: spawn `claude` with the given CLAUDE_CONFIG_DIR,
 * wait for the REPL, send /usage, capture until the panel settles
 * (idle-debounce + hard cap), parse, kill the PTY.
 */
export async function runUsageOnce(configDir: string | null, ev: UsageEvents = {}): Promise<UsageRun> {
  const started = Date.now();
  let buf = '';
  let term: ReturnType<typeof spawnClaude>;
  try {
    term = spawnClaude(configDir);
  } catch (err) {
    return {
      ok: false,
      loggedIn: null,
      parsed: null,
      raw: '',
      error: `failed to spawn claude: ${msg(err)}`,
      durationMs: Date.now() - started,
    };
  }
  const sub = term.onData((d) => {
    buf += d;
    ev.onData?.(d);
  });

  async function waitForReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let trustAccepted = false;
    while (Date.now() < deadline) {
      const clean = cleanCapture(buf);
      if (looksLoggedOut(clean)) throw new Error('not logged in');
      // whitespace-insensitive: repaints may drop spaces once ANSI is stripped
      if (/\?\s*for\s*shortcuts/.test(clean)) return;
      if (!trustAccepted && /do\s*you\s*trust/i.test(clean)) {
        // First run in our empty scratch dir — accept the folder-trust prompt.
        trustAccepted = true;
        await sleep(300);
        term.write('\r');
      }
      await sleep(150);
    }
    throw new Error('timed out waiting for the claude REPL prompt');
  }

  async function captureUntilIdle(): Promise<void> {
    const start = Date.now();
    let lastLen = buf.length;
    let lastChange = Date.now();
    for (;;) {
      await sleep(200);
      if (buf.length !== lastLen) {
        lastLen = buf.length;
        lastChange = Date.now();
      }
      const elapsed = Date.now() - start;
      if (elapsed >= PANEL_CAP_MS) return;
      if (elapsed >= PANEL_MIN_MS && Date.now() - lastChange >= PANEL_IDLE_MS) return;
    }
  }

  try {
    ev.onPhase?.('starting claude REPL');
    await waitForReady();
    ev.onPhase?.('running /usage');
    term.write('/usage');
    await sleep(400); // let the slash-command autocomplete settle before Enter
    term.write('\r');
    ev.onPhase?.('capturing panel');
    await captureUntilIdle();
    const raw = cleanCapture(buf);
    const parsed = parseUsage(raw);
    const ok = parsed.sections.length > 0;
    return {
      ok,
      loggedIn: true,
      parsed,
      raw: raw.slice(-RAW_TAIL_CHARS),
      error: ok ? null : 'no usage sections found in the /usage panel — see raw output',
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const raw = cleanCapture(buf);
    const loggedOut = looksLoggedOut(raw);
    return {
      ok: false,
      loggedIn: loggedOut ? false : null,
      parsed: null,
      raw: raw.slice(-RAW_TAIL_CHARS),
      error: loggedOut ? 'not logged in — open the login panel for this account first' : msg(err),
      durationMs: Date.now() - started,
    };
  } finally {
    sub.dispose();
    try {
      term.write('\u001b'); // Esc closes the panel for a tidy exit; PTY dies right after anyway
    } catch {
      /* already dead */
    }
    try {
      term.kill();
    } catch {
      /* already dead */
    }
  }
}

export async function checkUsage(acc: AccountConfig, ev: UsageEvents = {}): Promise<UsageResult> {
  const run = await runUsageOnce(acc.configDir, ev);
  return { label: acc.label, checkedAt: new Date().toISOString(), ...run };
}
