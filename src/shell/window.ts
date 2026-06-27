import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, nativeTheme, screen, shell } from 'electron';

import { REPO_ROOT } from '../paths.js';
import { appendLog } from '../log-buffer.js';
import type { AppContext } from '../context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_MAC = process.platform === 'darwin';

// The popover's width is fixed by design; only its height tracks the content.
// Never read the width back from the window to re-apply it: on Windows a
// frameless, non-resizable window can report a slightly smaller logical width
// than was set (frameless content-vs-outer + fractional display scaling), and
// since every fit re-applied whatever it read, that error ratcheted the popover
// down into a tall, unreadable sliver over successive fits. macOS was fine (the
// round-trip is exact there). Pinning the width makes it immune on every OS.
const POPOVER_WIDTH = 340;

export interface WindowController {
  /** Create the popover BrowserWindow and store it on ctx.win. */
  create(): void;
  /** Re-anchor the popover to the tray icon. */
  position(): void;
  /** Position, show, and focus the popover. */
  show(): void;
  /** Show if hidden, hide if visible. */
  toggle(): void;
  /** Resize the popover to a content height, then re-anchor it on-screen. */
  resize(height: number): void;
}

export function createWindowController(ctx: AppContext): WindowController {
  // The popover's intended height, owned here and NEVER read back from the OS —
  // same reason the width is a constant (see POPOVER_WIDTH). On Windows with
  // fractional display scaling, reading the current bounds back rounds down a
  // fraction, so re-applying what we read shrinks the window a hair on every
  // move. position() runs on each open, so that drift accumulated until a quota
  // check happened to call resize() and re-pin the size. We pin BOTH dimensions
  // to these intended values on every move instead, so neither can ratchet.
  let popoverHeight = 360; // initial; resize() updates it as content changes

  function position(): void {
    if (!ctx.win || !ctx.tray) return;
    const tb = ctx.tray.getBounds();
    const area = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
    // Horizontal: center on the icon, clamped into the work area.
    let x = Math.round(tb.x + tb.width / 2 - POPOVER_WIDTH / 2);
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - POPOVER_WIDTH - 4));
    // Vertical: drop BELOW a top tray (the macOS menu bar) or rise ABOVE a
    // bottom tray (the Windows taskbar) — decided by which half of the display
    // the icon sits in. The clamp then guarantees it stays fully on-screen
    // (without it, a bottom tray would push the popover off the bottom edge —
    // the "nothing happens when I click the icon" bug on Windows).
    const trayAtTop = tb.y + tb.height / 2 < area.y + area.height / 2;
    let y = trayAtTop ? tb.y + tb.height + 4 : tb.y - popoverHeight - 4;
    y = Math.max(area.y + 4, Math.min(y, area.y + area.height - popoverHeight - 4));
    // setBounds (not setPosition) with the pinned width + intended height: this
    // re-asserts the exact size on every move, so a move can't shrink it.
    ctx.win.setBounds({ x, y, width: POPOVER_WIDTH, height: popoverHeight }, false);
  }

  function show(): void {
    if (!ctx.win) return;
    position();
    ctx.win.show();
    ctx.win.focus();
  }

  function toggle(): void {
    if (!ctx.win) return;
    if (ctx.win.isVisible()) ctx.win.hide();
    else show();
  }

  function resize(height: number): void {
    if (!ctx.win) return;
    const desired = Math.round(height);
    if (!Number.isFinite(desired) || desired < 80) {
      console.log(`[cqm] win:resize rejected: ${height}`);
      return;
    }
    // Width is always the design width (never read back — see POPOVER_WIDTH); only
    // the height tracks content. Cap the height to the work area, record it as the
    // intended height, then let position() apply the size + on-screen placement.
    // Doing both keeps the popover flush with the tray on either platform:
    // re-anchoring is a no-op on macOS (the menu-bar tray doesn't move) and keeps
    // the bottom edge pinned above the taskbar on Windows as content height changes.
    const area = screen.getDisplayNearestPoint(ctx.win.getBounds()).workArea;
    popoverHeight = Math.min(desired, area.height - 8);
    position();
  }

  function create(): void {
    const base: Electron.BrowserWindowConstructorOptions = {
      width: POPOVER_WIDTH,
      height: 360, // initial only — the renderer fits the window to its content

      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        // ESM preload must use the .mjs extension or Electron loads it as CommonJS.
        preload: path.join(__dirname, '..', 'preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // required so the ESM preload can load
      },
    };
    const win = new BrowserWindow(
      IS_MAC
        ? {
            ...base,
            roundedCorners: true,
            // `popover` is the frosted system menu/popover material (like the
            // Wi-Fi menu or the "Hot" app), not the darker `under-window`
            // material. With it, the transparent body shows the frost through.
            vibrancy: 'popover',
            visualEffectState: 'active',
            backgroundColor: '#00000000',
          }
        : {
            ...base,
            // Windows/Linux have no vibrancy backing, so a transparent body
            // would render the popover invisible. Paint an opaque themed panel
            // instead (the renderer's CSS variables fill in the rest).
            backgroundColor: nativeTheme.shouldUseDarkColors ? '#28282a' : '#f6f6f6',
          },
    );
    ctx.win = win;

    void win.loadFile(path.join(REPO_ROOT, 'web', 'index.html'));

    // target=_blank / window.open (OAuth URLs, the repo link) → default browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    // Never let an in-app click navigate the popover away from the dashboard.
    win.webContents.on('will-navigate', (e, url) => {
      if (url !== win.webContents.getURL()) {
        e.preventDefault();
        if (/^https?:/.test(url)) void shell.openExternal(url);
      }
    });

    // Renderer recovery: if the web process genuinely crashes or the page fails
    // to load, the popover would otherwise stay a dead blank panel until restart,
    // so reload it to self-heal. Two hazards make a naive reload-on-every-event
    // worse than the disease, and both bit Windows:
    //   1. `render-process-gone` ALSO fires for non-crashes — `clean-exit` on a
    //      normal teardown and `killed` during a reload's own process swap — so
    //      reloading on those turns one reload into a self-feeding loop.
    //   2. A persistent failure (a renderer that crashes on every load) would
    //      reload forever, the panel resetting every cycle and discarding any
    //      in-flight /usage results — i.e. "can't even check usage".
    // So: reload only on real crashes, and cap the burst — after a few reloads in
    // a short window, give up and leave the last frame standing rather than thrash.
    let reloadCount = 0;
    let reloadWindowStart = 0;
    const selfHeal = (why: string): void => {
      if (win.isDestroyed()) return;
      const now = Date.now();
      if (now - reloadWindowStart > 10_000) {
        reloadWindowStart = now;
        reloadCount = 0;
      }
      if (reloadCount >= 3) {
        appendLog('window:recovery', `suppressed reload (${why}): too many reloads, giving up`);
        return;
      }
      reloadCount++;
      appendLog('window:recovery', `reloading popover (${why})`);
      void win.loadFile(path.join(REPO_ROOT, 'web', 'index.html'));
    };
    win.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit' || details.reason === 'killed') return;
      selfHeal(`render-process-gone:${details.reason}`);
    });
    win.webContents.on('did-fail-load', (_e, errorCode, desc, _url, isMainFrame) => {
      // -3 is ERR_ABORTED (a deliberate navigation cancel), not a real failure.
      if (isMainFrame && errorCode !== -3) selfHeal(`did-fail-load:${errorCode} ${desc}`);
    });

    // Popover dismiss: hide when focus leaves (unless devtools is open).
    win.on('blur', () => {
      if (!win.webContents.isDevToolsOpened()) win.hide();
    });
  }

  return { create, position, show, toggle, resize };
}
