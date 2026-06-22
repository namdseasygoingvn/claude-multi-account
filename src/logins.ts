import { spawnClaude } from './session.js';
import { cleanCapture } from './parse.js';
import { ensureOnboarded, probeLogin } from './registry.js';
import { AUTO_KEY_DELAY_MS, matchAutoRule } from './login-autorules.js';

const SNAPSHOT_TAIL = 6_000;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
/** How often to probe the config dir for a completed login. */
const SUCCESS_POLL_MS = 1_500;
/**
 * After authentication the session keeps running (still auto-pressing Enter)
 * until the REPL prompt appears — killing it earlier leaves onboarding
 * incomplete and the config dir re-runs setup screens on every later spawn.
 * This is the hard ceiling on that wind-down.
 */
const SUCCESS_MAX_LINGER_MS = 15_000;

export interface LoginEvents {
  onSnapshot: (label: string, snapshot: string) => void;
  onUrl: (label: string, url: string) => void;
  onStatus: (label: string, status: string) => void;
  onSuccess: (label: string, email: string | null) => void;
  onExit: (label: string, exitCode: number) => void;
}

interface LoginSession {
  term: ReturnType<typeof spawnClaude>;
  configDir: string;
  buf: string;
  urls: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  keyTimers: NodeJS.Timeout[];
  firedRules: Set<string>;
  /** Offset into the cleaned text already consumed by auto-rules. */
  autoCursor: number;
  succeeded: boolean;
}

/**
 * Login sessions: one interactive `claude` PTY per account being signed in.
 * Onboarding screens are answered automatically; OAuth URLs are surfaced to
 * the UI; success is detected by polling the config dir's state file, after
 * which the session stops itself. Credentials never pass through this code.
 */
export class LoginManager {
  private sessions = new Map<string, LoginSession>();

  constructor(private events: LoginEvents) {}

  isActive(label: string): boolean {
    return this.sessions.has(label);
  }

  start(label: string, configDir: string): void {
    this.stop(label);
    // Skip claude's first-run wizard so, once the browser sign-in persists a
    // token, the session lands in the REPL instead of looping the login picker.
    ensureOnboarded(configDir);
    // Wide PTY so long OAuth URLs render on a single line and can be linkified.
    const term = spawnClaude(configDir, { cols: 400, rows: 50 });
    const sess: LoginSession = {
      term,
      configDir,
      buf: '',
      urls: new Set(),
      flushTimer: null,
      pollTimer: null,
      keyTimers: [],
      firedRules: new Set(),
      autoCursor: 0,
      succeeded: false,
    };
    this.sessions.set(label, sess);
    this.events.onStatus(label, 'starting claude');
    term.onData((d) => {
      sess.buf += d;
      if (sess.buf.length > 400_000) {
        const drop = sess.buf.length - 200_000;
        sess.buf = sess.buf.slice(drop);
        sess.autoCursor = Math.max(0, sess.autoCursor - drop);
      }
      // Debounce so the UI gets settled frames, not every partial repaint.
      if (sess.flushTimer) clearTimeout(sess.flushTimer);
      sess.flushTimer = setTimeout(() => this.flush(label), 120);
    });
    sess.pollTimer = setInterval(() => this.checkSuccess(label), SUCCESS_POLL_MS);
    term.onExit(({ exitCode }) => {
      const current = this.sessions.get(label);
      if (current?.term === term) {
        this.clearTimers(current);
        this.sessions.delete(label);
      }
      this.events.onExit(label, exitCode);
    });
  }

  stop(label: string): boolean {
    const sess = this.sessions.get(label);
    if (!sess) return false;
    this.sessions.delete(label);
    this.clearTimers(sess);
    try {
      sess.term.kill();
    } catch {
      /* already dead */
    }
    return true;
  }

  stopAll(): void {
    for (const label of [...this.sessions.keys()]) this.stop(label);
  }

  /** Feed raw input to an account's live login PTY (e.g. a pasted OAuth code). */
  write(label: string, data: string): boolean {
    const sess = this.sessions.get(label);
    if (!sess) return false;
    try {
      sess.term.write(data);
      return true;
    } catch {
      return false;
    }
  }

  private clearTimers(sess: LoginSession): void {
    if (sess.flushTimer) clearTimeout(sess.flushTimer);
    if (sess.pollTimer) clearInterval(sess.pollTimer);
    for (const t of sess.keyTimers) clearTimeout(t);
    sess.keyTimers = [];
  }

  private flush(label: string): void {
    const sess = this.sessions.get(label);
    if (!sess) return;
    const clean = cleanCapture(sess.buf);
    for (const url of clean.match(URL_RE) ?? []) {
      if (!sess.urls.has(url)) {
        sess.urls.add(url);
        if (sess.urls.size === 1) {
          this.events.onStatus(label, 'waiting for you to finish sign-in in the browser');
        }
        this.events.onUrl(label, url);
      }
    }
    this.events.onSnapshot(label, clean.slice(-SNAPSHOT_TAIL));
    this.autoDrive(label, sess, clean);
    // Once authenticated, the session is done as soon as the REPL prompt
    // shows up — that means onboarding fully completed and was persisted.
    if (sess.succeeded && /\?\s*for\s*shortcuts/.test(clean.slice(-2_000))) {
      this.finish(label);
    }
  }

  private autoDrive(label: string, sess: LoginSession, clean: string): void {
    // One keystroke per flush; the next screen is handled on the next flush.
    const rule = matchAutoRule(clean.slice(sess.autoCursor), sess.firedRules);
    if (!rule) return;
    sess.firedRules.add(rule.key);
    sess.autoCursor = clean.length;
    if (!sess.succeeded) this.events.onStatus(label, rule.status);
    sess.keyTimers.push(
      setTimeout(() => {
        if (this.sessions.get(label) === sess) sess.term.write(rule.send ?? '\r');
      }, AUTO_KEY_DELAY_MS),
    );
  }

  private finish(label: string): void {
    if (!this.sessions.has(label)) return;
    this.events.onStatus(label, 'sign-in complete');
    this.stop(label);
  }

  private checkSuccess(label: string): void {
    const sess = this.sessions.get(label);
    if (!sess || sess.succeeded) return;
    const probe = probeLogin({ label, configDir: sess.configDir });
    if (!probe.loggedIn) return;
    sess.succeeded = true;
    this.events.onStatus(label, 'authenticated — finishing setup');
    this.events.onSuccess(label, probe.email);
    if (sess.pollTimer) {
      clearInterval(sess.pollTimer);
      sess.pollTimer = null;
    }
    // Normally finish() fires when the REPL prompt appears; this is the ceiling.
    sess.keyTimers.push(setTimeout(() => this.finish(label), SUCCESS_MAX_LINGER_MS));
  }
}
