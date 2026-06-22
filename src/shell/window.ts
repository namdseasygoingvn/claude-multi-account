import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen, shell } from 'electron';

import { REPO_ROOT } from '../paths.js';
import type { AppContext } from '../context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WindowController {
  /** Create the popover BrowserWindow and store it on ctx.win. */
  create(): void;
  /** Re-anchor the popover under the tray icon. */
  position(): void;
  /** Position, show, and focus the popover. */
  show(): void;
  /** Show if hidden, hide if visible. */
  toggle(): void;
}

export function createWindowController(ctx: AppContext): WindowController {
  function position(): void {
    if (!ctx.win || !ctx.tray) return;
    const tb = ctx.tray.getBounds();
    const wb = ctx.win.getBounds();
    const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
    const area = display.workArea;
    let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - wb.width - 4));
    const y = Math.round(tb.y + tb.height + 4);
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

  function create(): void {
    const win = new BrowserWindow({
      width: 340,
      height: 360, // initial only — the renderer fits the window to its content

      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      roundedCorners: true,
      // `popover` is the frosted system menu/popover material (like the Wi-Fi
      // menu or the "Hot" app), not the darker `under-window` window material.
      vibrancy: 'popover',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
      webPreferences: {
        // ESM preload must use the .mjs extension or Electron loads it as CommonJS.
        preload: path.join(__dirname, '..', 'preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // required so the ESM preload can load
      },
    });
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

  return { create, position, show, toggle };
}
