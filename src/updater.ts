// ── Auto-update (notify + one-click install) ─────────────────────────────────
// Neither platform gets a code-signing cert in CI, so the framework auto-updaters
// (Squirrel.Mac / NSIS differential) aren't reliable here. Instead we poll the
// GitHub Releases API, and when a newer version exists we surface it in the tray
// menu + a native notification. One click downloads THIS platform's installer and
// runs it:
//   • macOS   — mount the .dmg and swap the .app bundle in place, then relaunch,
//     so there's no Finder "replace?"/"in use" dialog and no drag-to-Applications.
//     Because the app (not a browser) fetched the .dmg, the swapped bundle carries
//     no quarantine flag, so the relaunch also skips the Gatekeeper prompt.
//   • Windows — launch the per-user NSIS setup .exe (no UAC) and quit so it can
//     replace the running app's files; its finish step relaunches the new version.
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { app, Notification, shell } from 'electron';

const execFileP = promisify(execFile);

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

/** Poll GitHub for the latest release and update module state. */
export async function checkForUpdates(opts: CheckOpts = {}): Promise<UpdateInfo | null> {
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
 * Windows: run the downloaded NSIS installer, then quit so it can replace the
 * running app's files. The installer is per-user (no UAC) and assisted — its
 * finish step relaunches the new version (the "Run …" box is checked by default).
 * We quit right after launching it so nothing is file-locked and it won't show an
 * "app is still running" page. Returns true once the installer is launched (we're
 * about to quit); false to fall back to opening the file for the user.
 */
async function applyUpdateWindows(exePath: string): Promise<boolean> {
  if (process.platform !== 'win32' || !app.isPackaged) return false;

  notify('Installing update', `Updating to ${available?.tag ?? 'the latest version'} and restarting…`);
  installing = true;
  try {
    // detached + unref so the installer outlives our process; spawn (no shell)
    // passes the path as a single argv element, so spaces in the name are safe.
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    installing = false;
    return false;
  }
  // Let the notification render, then quit so the installer can swap files.
  setTimeout(() => app.quit(), 500);
  return true;
}

/** Download this platform's installer, then run it (install in place + relaunch). */
export async function downloadAndInstall(): Promise<void> {
  const info = available;
  if (!info || downloading || installing) return;

  // No installer asset for this platform → just open the release page.
  if (!info.assetUrl) {
    await shell.openExternal(info.htmlUrl);
    return;
  }

  const isWin = process.platform === 'win32';
  downloading = true;
  onChange?.();
  try {
    // Keep the published filename (it encodes the arch + "-setup"); fall back to
    // a platform-correct extension if the API somehow omitted the name.
    const fileName = info.assetName || `ClaudeQuotaMonitor-${info.version}${isWin ? '.exe' : '.dmg'}`;
    const filePath = path.join(os.tmpdir(), fileName);
    const res = await fetch(info.assetUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    // Bridge the web ReadableStream from fetch() to a Node stream for piping.
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(filePath));

    // Preferred: install it ourselves and relaunch — no Finder/Explorer dialogs.
    const applied = isWin ? await applyUpdateWindows(filePath) : await applyUpdateMac(filePath);
    if (applied) return;

    // Fallback (not packaged / no write access / unexpected layout): hand the
    // downloaded installer to the OS so the user can finish manually.
    notify(
      'Update downloaded',
      isWin
        ? 'Opening the installer to finish updating.'
        : 'Opening the installer — drag the app into Applications to finish.',
    );
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
