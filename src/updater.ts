// Auto-update facade: one shared API (check / download / install + snapshot)
// dispatched to the right platform flow.
//   • Windows → electron-updater, one-click NSIS silent install  (updater-windows)
//   • macOS   → DIY .dmg mount + bundle swap                     (updater-mac)
// The flow is the same on both: check → "available" → download (with progress) →
// "ready" → install + relaunch. Shared update state + the renderer snapshot live
// in updater-shared; this file is wiring only.
import { checkForUpdatesWindows, downloadUpdateWindows, installUpdateWindows } from './updater-windows.js';
import { checkForUpdatesMac, downloadUpdateMac, installUpdateMac } from './updater-mac.js';
import type { CheckOpts, UpdateInfo } from './updater-shared.js';

export { getAvailableUpdate, getUpdateSnapshot, onUpdateStateChange } from './updater-shared.js';
export type { UpdateInfo, UpdateSnapshot, UpdatePhase } from './updater-shared.js';

const isWindows = process.platform === 'win32';

/** Check for a newer release and update module state (platform-dispatched). */
export function checkForUpdates(opts: CheckOpts = {}): Promise<UpdateInfo | null> {
  return isWindows ? checkForUpdatesWindows(opts) : checkForUpdatesMac(opts);
}

/** Download the available installer for this platform (progress → "ready"). */
export function downloadUpdate(): Promise<void> {
  return isWindows ? downloadUpdateWindows() : downloadUpdateMac();
}

/** Install the staged update for this platform (install in place + relaunch). */
export function installUpdate(): Promise<void> {
  return isWindows ? installUpdateWindows() : installUpdateMac();
}
