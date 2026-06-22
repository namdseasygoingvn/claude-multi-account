// Auto-update facade: one shared API (checkForUpdates / downloadAndInstall /
// getAvailableUpdate / isDownloading) dispatched to the right platform flow.
//   • Windows → electron-updater, one-click NSIS silent install  (updater-windows)
//   • macOS   → DIY .dmg mount + bundle swap                     (updater-mac)
// Shared update state + helpers live in updater-shared; this file is wiring only.
import { checkForUpdatesWindows, downloadAndInstallWindows } from './updater-windows.js';
import { checkForUpdatesMac, downloadAndInstallMac } from './updater-mac.js';
import type { CheckOpts, UpdateInfo } from './updater-shared.js';

export { getAvailableUpdate, isDownloading, onUpdateStateChange } from './updater-shared.js';
export type { UpdateInfo } from './updater-shared.js';

const isWindows = process.platform === 'win32';

/** Check for a newer release and update module state (platform-dispatched). */
export function checkForUpdates(opts: CheckOpts = {}): Promise<UpdateInfo | null> {
  return isWindows ? checkForUpdatesWindows(opts) : checkForUpdatesMac(opts);
}

/** Install the available update for this platform (install in place + relaunch). */
export function downloadAndInstall(): Promise<void> {
  return isWindows ? downloadAndInstallWindows() : downloadAndInstallMac();
}
