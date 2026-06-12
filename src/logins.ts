import { spawnClaude } from './session.js';
import { cleanCapture } from './parse.js';

const SNAPSHOT_TAIL = 6_000;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

export interface LoginEvents {
  onSnapshot: (label: string, snapshot: string) => void;
  onUrl: (label: string, url: string) => void;
  onExit: (label: string, exitCode: number) => void;
}

interface LoginSession {
  term: ReturnType<typeof spawnClaude>;
  buf: string;
  urls: Set<string>;
  timer: NodeJS.Timeout | null;
}

/**
 * Human-driven login sessions: one interactive `claude` PTY per account being
 * signed in. Output is streamed to the UI as cleaned snapshots; OAuth URLs
 * are extracted so the user can click them; keystrokes from the UI are
 * written straight into the PTY. Credentials never pass through this code.
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
    const sess: LoginSession = { term, buf: '', urls: new Set(), timer: null };
    this.sessions.set(label, sess);
    term.onData((d) => {
      sess.buf += d;
      if (sess.buf.length > 400_000) sess.buf = sess.buf.slice(-200_000);
      // Debounce so the UI gets settled frames, not every partial repaint.
      if (sess.timer) clearTimeout(sess.timer);
      sess.timer = setTimeout(() => this.flush(label), 120);
    });
    term.onExit(({ exitCode }) => {
      const current = this.sessions.get(label);
      if (current?.term === term) this.sessions.delete(label);
      this.events.onExit(label, exitCode);
    });
  }

  write(label: string, data: string): boolean {
    const sess = this.sessions.get(label);
    if (!sess) return false;
    sess.term.write(data);
    return true;
  }

  stop(label: string): boolean {
    const sess = this.sessions.get(label);
    if (!sess) return false;
    this.sessions.delete(label);
    if (sess.timer) clearTimeout(sess.timer);
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

  private flush(label: string): void {
    const sess = this.sessions.get(label);
    if (!sess) return;
    const clean = cleanCapture(sess.buf);
    for (const url of clean.match(URL_RE) ?? []) {
      if (!sess.urls.has(url)) {
        sess.urls.add(url);
        this.events.onUrl(label, url);
      }
    }
    this.events.onSnapshot(label, clean.slice(-SNAPSHOT_TAIL));
  }
}
