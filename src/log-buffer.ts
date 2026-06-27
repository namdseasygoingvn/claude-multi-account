import type { BrowserWindow } from 'electron';

// Rolling in-memory log for the tray debug menu — captures renderer console
// messages (all levels) so failures that blank the window are recoverable
// without a DevTools session already open.
const MAX = 200;
const buf: string[] = [];

export function appendLog(tag: string, message: string): void {
  const ts = new Date().toLocaleTimeString();
  buf.push(`[${ts}][${tag}] ${message}`);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

export function getLog(): string {
  return buf.length > 0 ? buf.join('\n') : '(no log entries yet)';
}

/** Intercept main-process console.log/warn/error into the ring buffer. */
export function patchMainConsole(): void {
  for (const method of ['log', 'warn', 'error'] as const) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      appendLog(`main:${method}`, args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      orig(...args);
    };
  }
}

/** Subscribe to the renderer's console output and store it in the ring buffer. */
export function attachRendererLog(win: BrowserWindow): void {
  // level: 0=verbose 1=info 2=warning 3=error
  const TAGS = ['VERB', 'LOG', 'WARN', 'ERR'] as const;
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = TAGS[level] ?? String(level);
    const src = sourceId ? ` (${sourceId.replace(/.*[\\/]/, '')}:${line})` : '';
    appendLog(`rend:${tag}`, message + src);
  });
}
