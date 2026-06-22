import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, nativeTheme, screen, shell } from 'electron';

import { REPO_ROOT } from '../paths.js';
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
  function position(): void {
    if (!ctx.win || !ctx.tray) return;
    const tb = ctx.tray.getBounds();
    const wb = ctx.win.getBounds();
    const area = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
    // Horizontal: center on the icon, clamped into the work area.
    let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - wb.width - 4));
    // Vertical: drop BELOW a top tray (the macOS menu bar) or rise ABOVE a
    // bottom tray (the Windows taskbar) — decided by which half of the display
    // the icon sits in. The clamp then guarantees it stays fully on-screen
    // (without it, a bottom tray would push the popover off the bottom edge —
    // the "nothing happens when I click the icon" bug on Windows).
    const trayAtTop = tb.y + tb.height / 2 < area.y + area.height / 2;
    let y = trayAtTop ? tb.y + tb.height + 4 : tb.y - wb.height - 4;
    y = Math.max(area.y + 4, Math.min(y, area.y + area.height - wb.height - 4));
    ctx.win.setPosition(x, y, false);
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
    if (!Number.isFinite(desired) || desired < 80) return;
    // Width is always the design width (never read back — see POPOVER_WIDTH); only
    // the height tracks content. Cap the height to the work area, then let
    // position() place it on-screen. Doing both keeps the popover flush with the
    // tray on either platform: re-anchoring is a no-op on macOS (the menu-bar tray
    // doesn't move) and keeps the bottom edge pinned above the taskbar on Windows
    // as the content height changes.
    const area = screen.getDisplayNearestPoint(ctx.win.getBounds()).workArea;
    ctx.win.setSize(POPOVER_WIDTH, Math.min(desired, area.height - 8), false);
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

    // Popover dismiss: hide when focus leaves (unless devtools is open).
    win.on('blur', () => {
      if (!win.webContents.isDevToolsOpened()) win.hide();
    });
  }

  return { create, position, show, toggle, resize };
}
