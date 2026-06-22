import path from 'node:path';
import { app, Menu, Tray, nativeImage } from 'electron';

import { REPO_ROOT } from '../paths.js';
import { checkForUpdates, downloadAndInstall, getAvailableUpdate, isDownloading } from '../updater.js';
import type { AppContext } from '../context.js';

/** Cross-module actions the tray menu triggers, injected by main.ts. */
export interface TrayDeps {
  /** "Add account…" */
  addAccount(): void;
  /** "Repair / update Claude Code…" */
  repairClaude(): void;
  /** Tray-icon click: show the popover if hidden, hide it if visible. */
  toggleWindow(): void;
}

export interface TrayController {
  /** Create the Tray icon and wire its click handlers. */
  create(): void;
}

export function createTray(ctx: AppContext, deps: TrayDeps): TrayController {
  function trayImage(): Electron.NativeImage {
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(path.join(REPO_ROOT, 'assets', 'trayTemplate.png'));
      img.setTemplateImage(true); // macOS tints it for light/dark menu bars
      return img;
    }
    // Windows/Linux don't tint template images (they'd render as an invisible
    // solid-black blob), so use a COLORED icon. Windows prefers a multi-size .ico.
    const file =
      process.platform === 'win32'
        ? path.join(REPO_ROOT, 'assets', 'tray.ico')
        : path.join(REPO_ROOT, 'assets', 'tray.png');
    return nativeImage.createFromPath(file);
  }

  function buildContextMenu(): Electron.Menu {
    const update = getAvailableUpdate();
    const updateItem: Electron.MenuItemConstructorOptions = isDownloading()
      ? { label: 'Downloading update…', enabled: false }
      : update
        ? { label: `Install update ${update.tag} & restart`, click: () => void downloadAndInstall() }
        : {
            label: 'Check for updates',
            click: () => void checkForUpdates({ notifyOnUpdate: true, notifyOnResult: true }),
          };
    return Menu.buildFromTemplate([
      { label: `Claude Quota Monitor v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: 'Add account…', click: () => deps.addAccount() },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      updateItem,
      { label: 'Repair / update Claude Code…', click: () => deps.repairClaude() },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]);
  }

  function create(): void {
    const tray = new Tray(trayImage());
    ctx.tray = tray;
    tray.setToolTip('Claude Quota Monitor');
    tray.on('click', () => deps.toggleWindow());
    tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
    ctx.updateBadge();
  }

  return { create };
}
