// ── Auto-update (silent check → silent download → one-click install) ──────────
// Each platform updates differently, behind one shared API (checkForUpdates /
// downloadAndInstall / getAvailableUpdate / isDownloading):
//   • Windows — electron-updater (NSIS). It silently checks GitHub Releases,
//     auto-downloads in the background, and on click installs silently + relaunches
//     (quitAndInstall). Works unsigned. The release must carry `latest.yml` +
//     the installer's `.blockmap` (the release workflow uploads them).
//   • macOS   — there's no code-signing cert in CI, and Squirrel.Mac refuses to
//     apply unsigned updates, so electron-updater can't help here. We keep a DIY
//     flow: poll the Releases API, then mount the .dmg and swap the .app bundle in
//     place and relaunch — no Finder "replace?"/"in use" dialog, no drag-to-
//     Applications. Because the app (not a browser) fetched the .dmg, the swapped
//     bundle carries no quarantine flag, so the relaunch also skips Gatekeeper.
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { app, Notification, shell } from 'electron';
// electron-updater is CommonJS; this is the documented ESM import shape.
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const execFileP = promisify(execFile);
const isWindows = process.platform === 'win32';

// The GitHub repo that publishes releases (see .github/workflows/release.yml).
const OWNER = 'namdseasygoingvn';
const REPO = 'claude-multi-account';
const LATEST_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const UA = `${REPO}-updater`;

export interface UpdateInfo {
  version: string; // semver without the leading "v", e.g. "0.1.50"
  tag: string; // the release tag, e.g. "v0.1.50"
  htmlUrl: string; // release page (fallback if no matching asset is found)
  assetUrl: string | null; // direct download URL of THIS platform's installer (.dmg / .exe)
  assetName: string | null; // its filename — drives the temp path + which install flow runs
}

let available: UpdateInfo | null = null;
let downloading = false;
let installing = false; // a relaunch has been scheduled — block re-entry
let onChange: (() => void) | null = null;

// Windows (electron-updater) only: set once the installer is downloaded and
// staged, so downloadAndInstall() knows to quitAndInstall rather than re-fetch.
let readyToInstall = false;
// Whether the in-flight Windows check should surface a notification when the
// update finishes downloading (set per checkForUpdates call).
let notifyWhenReady = false;

/** Current update state for the tray menu. */
export function getAvailableUpdate(): UpdateInfo | null {
  return available;
}
export function isDownloading(): boolean {
  return downloading;
}
/** Called whenever update/download state changes, so the caller can refresh UI. */
export function onUpdateStateChange(cb: () => void): void {
  onChange = cb;
}

/** Compare dotted numeric versions. >0 if a is newer than b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pick the release asset for THIS OS + arch: a `.dmg` on macOS, the NSIS setup
 * `.exe` on Windows. Matches the arch token in the filename, falling back to any
 * asset of the right type (single-arch releases don't tag the name). Returns both
 * the URL and the published filename (the name encodes arch/"-setup").
 */
function pickAsset(
  assets: Array<{ name?: string; browser_download_url?: string }>,
): { url: string; name: string } | null {
  const ext = process.platform === 'win32' ? '.exe' : '.dmg';
  const cands = assets.filter((a) => a.name?.toLowerCase().endsWith(ext));
  if (cands.length === 0) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const alt = arch === 'x64' ? 'x86_64' : 'aarch64';
  const match = cands.find((a) => {
    const n = a.name!.toLowerCase();
    return n.includes(arch) || n.includes(alt);
  });
  const chosen = match ?? cands[0];
  return chosen.browser_download_url ? { url: chosen.browser_download_url, name: chosen.name ?? '' } : null;
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
}

interface CheckOpts {
  /** Show a notification when an update is found (auto checks + manual). */
  notifyOnUpdate?: boolean;
  /** Also notify "up to date" / "couldn't check" (manual checks only). */
  notifyOnResult?: boolean;
}

/**
 * Map electron-updater's UpdateInfo onto our shared shape. On Windows we don't
 * carry an asset URL/name — electron-updater owns the download + install.
 */
function toUpdateInfoEU(info: { version: string }): UpdateInfo {
  const version = String(info.version).replace(/^v/, '');
  return {
    version,
    tag: `v${version}`,
    htmlUrl: `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`,
    assetUrl: null,
    assetName: null,
  };
}

// Wire electron-updater's event stream onto our module state exactly once. We
// keep autoDownload off and drive downloadUpdate() ourselves so the tray can
// show a "Downloading…" → "Install & restart" progression and a manual check can
// report "up to date" without a surprise background fetch.
let winWired = false;
function ensureWinUpdater(): void {
  if (winWired) return;
  winWired = true;
  autoUpdater.autoDownload = false; // we call downloadUpdate() on demand
  autoUpdater.autoInstallOnAppQuit = true; // also apply a staged update on a normal quit
  autoUpdater.on('update-available', (info) => {
    available = toUpdateInfoEU(info);
    readyToInstall = false;
    onChange?.();
  });
  autoUpdater.on('download-progress', () => {
    if (!downloading) {
      downloading = true;
      onChange?.();
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    available = toUpdateInfoEU(info);
    downloading = false;
    readyToInstall = true;
    onChange?.();
    if (notifyWhenReady) {
      notify(
        'Update ready',
        `Claude Quota Monitor ${available.tag} is ready — click to restart and install.`,
        () => void downloadAndInstall(),
      );
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (available) {
      available = null;
      readyToInstall = false;
      onChange?.();
    }
  });
  autoUpdater.on('error', () => {
    // An environmental hiccup (offline, GitHub blip) shouldn't wedge the UI in
    // "Downloading…": drop back so the tray offers "Check for updates" again.
    downloading = false;
    onChange?.();
  });
}

/**
 * Windows path: electron-updater checks GitHub Releases and, when a newer version
 * exists, silently downloads it in the background. State + notifications flow
 * through the event handlers wired in ensureWinUpdater().
 */
async function checkForUpdatesWindows(opts: CheckOpts): Promise<UpdateInfo | null> {
  // No update feed in dev — app-update.yml ships only inside the packaged app.
  if (!app.isPackaged) return null;
  ensureWinUpdater();
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
    available = toUpdateInfoEU(info);
    onChange?.();
    // Kick off the silent download now; update-downloaded flips us to "ready".
    if (!downloading && !readyToInstall) {
      downloading = true;
      onChange?.();
      autoUpdater.downloadUpdate().catch(() => {
        downloading = false;
        onChange?.();
      });
    }
    return available;
  } catch {
    if (opts.notifyOnResult) {
      notify('Update check failed', "Couldn't reach GitHub. Check your connection and try again.");
    }
    return null;
  }
}

/** Check for a newer release and update module state (platform-dispatched). */
export async function checkForUpdates(opts: CheckOpts = {}): Promise<UpdateInfo | null> {
  return isWindows ? checkForUpdatesWindows(opts) : checkForUpdatesMac(opts);
}

/** macOS: poll the GitHub Releases API directly (see module header for why). */
async function checkForUpdatesMac(opts: CheckOpts): Promise<UpdateInfo | null> {
  let json: {
    tag_name?: string;
    html_url?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  try {
    const res = await fetch(LATEST_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    json = await res.json();
  } catch {
    if (opts.notifyOnResult) {
      notify('Update check failed', "Couldn't reach GitHub. Check your connection and try again.");
    }
    return null;
  }

  const tag = String(json.tag_name ?? '');
  const remote = tag.replace(/^v/, '');
  const current = app.getVersion();

  if (!remote || cmpVersion(remote, current) <= 0) {
    if (available) {
      available = null;
      onChange?.();
    }
    if (opts.notifyOnResult) {
      notify("You're up to date", `Claude Quota Monitor v${current} is the latest version.`);
    }
    return null;
  }

  const asset = pickAsset(json.assets ?? []);
  available = {
    version: remote,
    tag,
    htmlUrl: String(json.html_url ?? `https://github.com/${OWNER}/${REPO}/releases/latest`),
    assetUrl: asset?.url ?? null,
    assetName: asset?.name ?? null,
  };
  onChange?.();
  if (opts.notifyOnUpdate) {
    notify('Update available', `Claude Quota Monitor ${tag} is ready — click to install.`, () =>
      void downloadAndInstall(),
    );
  }
  return available;
}

// A detached helper that swaps the app bundle once we've quit, then relaunches.
// Values arrive as argv (not interpolated), so spaces in "Claude Quota Monitor.app"
// are safe. It backs up the old bundle and restores it if the swap fails, so a
// failed update never leaves the user without a working app.
const RELAUNCH_SCRIPT = `#!/bin/bash
# args: PID SRC DEST STAGING MOUNT DMG SELF
PID="$1"; SRC="$2"; DEST="$3"; STAGING="$4"; MOUNT="$5"; DMG="$6"; SELF="$7"
# Wait for the running app to fully quit (up to ~60s).
for i in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
/bin/rm -rf "$STAGING" 2>/dev/null
if /usr/bin/ditto "$SRC" "$STAGING"; then
  /bin/mv "$DEST" "$DEST.old" 2>/dev/null
  if /bin/mv "$STAGING" "$DEST"; then
    /bin/rm -rf "$DEST.old" 2>/dev/null
  else
    /bin/mv "$DEST.old" "$DEST" 2>/dev/null
  fi
fi
/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
/usr/bin/hdiutil detach "$MOUNT" -quiet 2>/dev/null
/bin/rm -f "$DMG" 2>/dev/null
/usr/bin/open "$DEST"
/bin/rm -f "$SELF" 2>/dev/null
`;

/**
 * Install the downloaded .dmg in place and relaunch — no Finder drag, no
 * "replace?"/"in use" dialogs. Mounts the dmg, then hands a detached helper the
 * job of swapping the bundle once we quit. Returns true if the relauncher was
 * launched (app is about to quit); false to fall back to opening the dmg.
 */
async function applyUpdateMac(dmgPath: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged) return false;

  const exe = app.getPath('exe');
  const i = exe.indexOf('.app/');
  if (i === -1) return false;
  const appBundle = exe.slice(0, i + 4); // e.g. /Applications/Claude Quota Monitor.app

  // We need to replace the bundle without elevation; if not, fall back to manual.
  try {
    await access(path.dirname(appBundle), fsConstants.W_OK);
  } catch {
    return false;
  }

  const mount = path.join(os.tmpdir(), `cqm-mnt-${process.pid}-${Date.now()}`);
  try {
    await mkdir(mount, { recursive: true });
    await execFileP('hdiutil', ['attach', dmgPath, '-nobrowse', '-noverify', '-mountpoint', mount]);
  } catch {
    return false;
  }

  let srcApp: string | null = null;
  try {
    const appName = (await readdir(mount)).find((n) => n.endsWith('.app'));
    if (appName) srcApp = path.join(mount, appName);
  } catch {
    /* fall through to detach + bail */
  }
  if (!srcApp) {
    await execFileP('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
    return false;
  }

  const staging = appBundle.replace(/\.app$/, '.update.app');
  const scriptPath = path.join(os.tmpdir(), `cqm-relaunch-${process.pid}-${Date.now()}.sh`);
  await writeFile(scriptPath, RELAUNCH_SCRIPT, { mode: 0o755 });

  notify('Installing update', `Updating to ${available?.tag ?? 'the latest version'} and restarting…`);

  installing = true;
  spawn(
    '/bin/bash',
    [scriptPath, String(process.pid), srcApp, appBundle, staging, mount, dmgPath, scriptPath],
    { detached: true, stdio: 'ignore' },
  ).unref();

  // Let the notification render, then quit so the helper can swap the
  // (no-longer-running) bundle and relaunch the new version.
  setTimeout(() => app.quit(), 500);
  return true;
}

/**
 * Windows: apply the update electron-updater has already staged — install
 * silently and relaunch (quitAndInstall: isSilent=true, forceRunAfter=true), no
 * NSIS wizard, no UAC (per-user install). If the click lands before the silent
 * background download has finished, start/await it instead; update-downloaded
 * then notifies the user it's ready.
 */
async function downloadAndInstallWindows(): Promise<void> {
  if (!app.isPackaged || installing) return;
  ensureWinUpdater();

  if (readyToInstall) {
    installing = true;
    notify('Installing update', `Updating to ${available?.tag ?? 'the latest version'} and restarting…`);
    // Let the notification render, then install silently and relaunch.
    setTimeout(() => autoUpdater.quitAndInstall(true /* isSilent */, true /* forceRunAfter */), 500);
    return;
  }

  // Not staged yet — make sure the download is running and surface it when ready.
  if (!downloading) {
    notifyWhenReady = true;
    downloading = true;
    onChange?.();
    autoUpdater.downloadUpdate().catch(() => {
      downloading = false;
      onChange?.();
    });
  }
}

/** Install the available update for this platform (install in place + relaunch). */
export async function downloadAndInstall(): Promise<void> {
  if (isWindows) return downloadAndInstallWindows();

  const info = available;
  if (!info || downloading || installing) return;

  // No installer asset for this platform → just open the release page.
  if (!info.assetUrl) {
    await shell.openExternal(info.htmlUrl);
    return;
  }

  downloading = true;
  onChange?.();
  try {
    // Keep the published filename (it encodes the arch + "-setup"); fall back to
    // a platform-correct extension if the API somehow omitted the name.
    const fileName = info.assetName || `ClaudeQuotaMonitor-${info.version}.dmg`;
    const filePath = path.join(os.tmpdir(), fileName);
    const res = await fetch(info.assetUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    // Bridge the web ReadableStream from fetch() to a Node stream for piping.
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(filePath));

    // Preferred: install it ourselves and relaunch — no Finder dialogs.
    const applied = await applyUpdateMac(filePath);
    if (applied) return;

    // Fallback (not packaged / no write access / unexpected layout): hand the
    // downloaded installer to the OS so the user can finish manually.
    notify('Update downloaded', 'Opening the installer — drag the app into Applications to finish.');
    await shell.openPath(filePath);
  } catch {
    // Last resort: open the release page so the user can grab it manually.
    notify('Update failed', 'Opening the release page so you can download it manually.');
    await shell.openExternal(info.htmlUrl);
  } finally {
    downloading = false;
    onChange?.();
  }
}
