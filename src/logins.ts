import { spawnClaude } from './session.js';
import { cleanCapture, TRUST_PROMPT_RE } from './parse.js';
import { probeLogin } from './registry.js';

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
/** Delay between detecting a known screen and answering it, so the menu finishes painting. */
const AUTO_KEY_DELAY_MS = 400;

export interface LoginEvents {
  onSnapshot: (label: string, snapshot: string) => void;
  onUrl: (label: string, url: string) => void;
  onStatus: (label: string, status: string) => void;
  onSuccess: (label: string, email: string | null) => void;
  onExit: (label: string, exitCode: number) => void;
}

interface AutoRule {
  key: string;
  re: RegExp;
  status: string;
  /** Screens that can appear more than once (e.g. "Press Enter to continue"). */
  repeatable?: boolean;
}

/**
 * Auto-drive the human-free part of onboarding by pressing Enter on each
 * known screen: default theme, "Claude account with subscription" (the
 * pre-selected login method), folder trust, and any "press Enter to
 * continue" interstitial. The actual browser sign-in stays human.
 * Patterns are whitespace-insensitive — TUI repaints can drop spaces.
 */
const AUTO_RULES: AutoRule[] = [
  { key: 'theme', re: /Choose\s*the\s*text\s*style/i, status: 'picking default theme' },
  { key: 'method', re: /Select\s*login\s*method/i, status: 'choosing Claude subscription sign-in' },
  { key: 'trust', re: TRUST_PROMPT_RE, status: 'accepting folder trust' },
  { key: 'continue', re: /Press\s*Enter\s*to\s*continue/i, status: 'continuing', repeatable: true },
];

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
    const fresh = clean.slice(sess.autoCursor);
    for (const rule of AUTO_RULES) {
      if (!rule.repeatable && sess.firedRules.has(rule.key)) continue;
      if (!rule.re.test(fresh)) continue;
      sess.firedRules.add(rule.key);
      sess.autoCursor = clean.length;
      if (!sess.succeeded) this.events.onStatus(label, rule.status);
      sess.keyTimers.push(
        setTimeout(() => {
          if (this.sessions.get(label) === sess) sess.term.write('\r');
        }, AUTO_KEY_DELAY_MS),
      );
      break; // one keystroke per flush; the next screen is handled on the next flush
    }
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
