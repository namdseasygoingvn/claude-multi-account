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
  flashUpToDate,
  getAvailableUpdate,
  isDownloading,
  isInstalling,
  isReady,
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
// Surface a notification when the update finishes downloading (set when the user
// kicks off a download, so the "ready — click to restart" prompt is expected).
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
    setUpdateState({ available: toUpdateInfo(info), ready: false, error: null });
  });
  autoUpdater.on('download-progress', (p) => {
    setUpdateState({ downloading: true, progress: Math.round(p?.percent ?? 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    readyToInstall = true;
    setUpdateState({ available: toUpdateInfo(info), downloading: false, progress: 100, ready: true });
    if (notifyWhenReady) {
      notify('Update ready', `Claude Quota Monitor v${info.version} is ready — click to restart and install.`, () =>
        void installUpdateWindows(),
      );
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (getAvailableUpdate()) {
      readyToInstall = false;
      setUpdateState({ available: null, ready: false, progress: null });
    }
  });
  autoUpdater.on('error', (err) => {
    // An environmental hiccup (offline, GitHub blip) — or a failed install —
    // shouldn't wedge the UI in "Downloading…"/"Installing…": drop back so the
    // popover offers a retry. If the user explicitly asked to install, surface the
    // failure with a manual-download fallback rather than failing silently.
    setUpdateState({ downloading: false, installing: false, progress: null, error: 'Update failed' });
    if (notifyOnError) {
      notifyOnError = false;
      notifyInstallFailed(err);
    }
  });
}

/** Begin the background download; surface a failure if one was asked for. */
function startDownload(): void {
  setUpdateState({ downloading: true, progress: 0, error: null });
  autoUpdater.downloadUpdate().catch((err) => {
    setUpdateState({ downloading: false, progress: null, error: 'Download failed' });
    if (notifyOnError) {
      notifyOnError = false;
      notifyInstallFailed(err);
    }
  });
}

/**
 * electron-updater checks GitHub Releases for a newer version. We DON'T download
 * here — the popover offers an explicit "Download" so the user controls when the
 * fetch happens (no surprise background traffic, no half-finished install racing
 * a quit). State + notifications flow through the handlers wired in ensureWired().
 */
export async function checkForUpdatesWindows(opts: CheckOpts): Promise<UpdateInfo | null> {
  // No update feed in dev — app-update.yml ships only inside the packaged app.
  if (!app.isPackaged) return null;
  ensureWired();
  setUpdateState({ checking: true, error: null, upToDate: false });
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    if (!info || cmpVersion(String(info.version).replace(/^v/, ''), app.getVersion()) <= 0) {
      setUpdateState({ checking: false, available: null, ready: false });
      if (opts.notifyOnResult) {
        flashUpToDate();
        notify("You're up to date", `Claude Quota Monitor v${app.getVersion()} is the latest version.`);
      }
      return null;
    }
    const available = toUpdateInfo(info);
    setUpdateState({ checking: false, available });
    if (opts.notifyOnUpdate) {
      notify('Update available', `Claude Quota Monitor ${available.tag} is ready to download.`);
    }
    return available;
  } catch {
    setUpdateState({ checking: false, error: 'Update check failed' });
    if (opts.notifyOnResult) {
      notify('Update check failed', "Couldn't reach GitHub. Check your connection and try again.");
    }
    return null;
  }
}

/** Begin downloading the staged installer (progress flows to the popover). */
export async function downloadUpdateWindows(): Promise<void> {
  if (!app.isPackaged || isInstalling() || isDownloading() || isReady()) return;
  ensureWired();
  notifyWhenReady = true; // surface a "ready — restart" prompt when it finishes
  startDownload();
}

/**
 * Apply the update electron-updater has already staged — install silently and
 * relaunch (quitAndInstall: isSilent=true, forceRunAfter=true), no NSIS wizard,
 * no UAC (per-user install). Guarded on readyToInstall so an install never fires
 * before the download truly finishes (which would loop "update available").
 */
export async function installUpdateWindows(): Promise<void> {
  if (!app.isPackaged || isInstalling()) return;
  ensureWired();

  // Not fully downloaded yet — start/continue the download instead of installing.
  if (!readyToInstall) {
    void downloadUpdateWindows();
    return;
  }

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
}
