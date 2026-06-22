// ── Windows auto-update — electron-updater (NSIS) ─────────────────────────────
// electron-updater silently checks GitHub Releases, downloads in the background,
// and on click installs silently + relaunches (quitAndInstall). Works unsigned.
// We ship a ONE-CLICK per-user NSIS installer (package.json → build.nsis), which
// is the only NSIS variant whose silent install actually applies — an assisted
// installer would quit the app and no-op, looping "update available" forever.
// The release must carry `latest.yml` + the installer's `.blockmap` (uploaded by
// the release workflow) for detection + differential download.
import { app } from 'electron';
// electron-updater is CommonJS; this is the documented ESM import shape.
import electronUpdater from 'electron-updater';
import {
  cmpVersion,
  getAvailableUpdate,
  isDownloading,
  isInstalling,
  notify,
  notifyInstallFailed,
  setUpdateState,
  type CheckOpts,
  type UpdateInfo,
  OWNER,
  REPO,
} from './updater-shared.js';

const { autoUpdater } = electronUpdater;

// Set once the installer is downloaded + staged, so install knows to
// quitAndInstall rather than re-fetch.
let readyToInstall = false;
// Surface a notification when the update finishes downloading (set per check).
let notifyWhenReady = false;
// The user explicitly asked to install: a failure should then tell them (with a
// manual-download fallback) instead of silently looping.
let notifyOnError = false;

/**
 * Map electron-updater's UpdateInfo onto our shared shape. On Windows we don't
 * carry an asset URL/name — electron-updater owns the download + install.
 */
function toUpdateInfo(info: { version: string }): UpdateInfo {
  const version = String(info.version).replace(/^v/, '');
  return {
    version,
    tag: `v${version}`,
    htmlUrl: `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`,
    assetUrl: null,
    assetName: null,
  };
}

// Wire electron-updater's event stream onto our shared state exactly once. We
// keep autoDownload off and drive downloadUpdate() ourselves so the tray can
// show a "Downloading…" → "Install & restart" progression and a manual check can
// report "up to date" without a surprise background fetch.
let wired = false;
function ensureWired(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false; // we call downloadUpdate() on demand
  autoUpdater.autoInstallOnAppQuit = true; // also apply a staged update on a normal quit
  autoUpdater.on('update-available', (info) => {
    readyToInstall = false;
    setUpdateState({ available: toUpdateInfo(info) });
  });
  autoUpdater.on('download-progress', () => {
    if (!isDownloading()) setUpdateState({ downloading: true });
  });
  autoUpdater.on('update-downloaded', (info) => {
    readyToInstall = true;
    setUpdateState({ available: toUpdateInfo(info), downloading: false });
    if (notifyWhenReady) {
      notify('Update ready', `Claude Quota Monitor v${info.version} is ready — click to restart and install.`, () =>
        void downloadAndInstallWindows(),
      );
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (getAvailableUpdate()) {
      readyToInstall = false;
      setUpdateState({ available: null });
    }
  });
  autoUpdater.on('error', (err) => {
    // An environmental hiccup (offline, GitHub blip) — or a failed install —
    // shouldn't wedge the UI in "Downloading…"/"Installing…": drop back so the
    // tray offers a retry. If the user explicitly asked to install, surface the
    // failure with a manual-download fallback rather than failing silently.
    setUpdateState({ downloading: false, installing: false });
    if (notifyOnError) {
      notifyOnError = false;
      notifyInstallFailed(err);
    }
  });
}

/** Begin the silent background download; surface a failure if one was asked for. */
function startDownload(): void {
  setUpdateState({ downloading: true });
  autoUpdater.downloadUpdate().catch((err) => {
    setUpdateState({ downloading: false });
    if (notifyOnError) {
      notifyOnError = false;
      notifyInstallFailed(err);
    }
  });
}

/**
 * electron-updater checks GitHub Releases and, when a newer version exists,
 * silently downloads it in the background. State + notifications flow through the
 * event handlers wired in ensureWired().
 */
export async function checkForUpdatesWindows(opts: CheckOpts): Promise<UpdateInfo | null> {
  // No update feed in dev — app-update.yml ships only inside the packaged app.
  if (!app.isPackaged) return null;
  ensureWired();
  notifyWhenReady = !!opts.notifyOnUpdate;
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    if (!info || cmpVersion(String(info.version).replace(/^v/, ''), app.getVersion()) <= 0) {
      if (opts.notifyOnResult) {
        notify("You're up to date", `Claude Quota Monitor v${app.getVersion()} is the latest version.`);
      }
      return null;
    }
    const available = toUpdateInfo(info);
    setUpdateState({ available });
    // Kick off the silent download now; update-downloaded flips us to "ready".
    if (!isDownloading() && !readyToInstall) startDownload();
    return available;
  } catch {
    if (opts.notifyOnResult) {
      notify('Update check failed', "Couldn't reach GitHub. Check your connection and try again.");
    }
    return null;
  }
}

/**
 * Apply the update electron-updater has already staged — install silently and
 * relaunch (quitAndInstall: isSilent=true, forceRunAfter=true), no NSIS wizard,
 * no UAC (per-user install). If the click lands before the silent background
 * download has finished, start/await it instead; update-downloaded then notifies.
 */
export async function downloadAndInstallWindows(): Promise<void> {
  if (!app.isPackaged || isInstalling()) return;
  ensureWired();

  if (readyToInstall) {
    notifyOnError = true; // a failed install should tell the user, not loop quietly
    setUpdateState({ installing: true });
    notify('Installing update', `Updating to ${getAvailableUpdate()?.tag ?? 'the latest version'} and restarting…`);
    // Let the notification render, then install silently and relaunch. If
    // quitAndInstall throws synchronously, fall back rather than wedging.
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true /* isSilent */, true /* forceRunAfter */);
      } catch (err) {
        notifyOnError = false;
        setUpdateState({ installing: false });
        notifyInstallFailed(err);
      }
    }, 500);
    return;
  }

  // Not staged yet — make sure the download is running and surface it when ready.
  if (!isDownloading()) {
    notifyWhenReady = true;
    startDownload();
  }
}
