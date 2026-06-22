// ── macOS auto-update — DIY .dmg swap ─────────────────────────────────────────
// There's no code-signing cert in CI, and Squirrel.Mac refuses to apply unsigned
// updates, so electron-updater can't help here. Instead we poll the Releases API,
// then mount the .dmg and swap the .app bundle in place and relaunch — no Finder
// "replace?"/"in use" dialog, no drag-to-Applications. Because the app (not a
// browser) fetched the .dmg, the swapped bundle carries no quarantine flag, so
// the relaunch also skips Gatekeeper.
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { app, shell } from 'electron';
import {
  cmpVersion,
  getAvailableUpdate,
  isDownloading,
  isInstalling,
  LATEST_URL,
  notify,
  pickAsset,
  setUpdateState,
  OWNER,
  REPO,
  UA,
  type CheckOpts,
  type UpdateInfo,
} from './updater-shared.js';
import { RELAUNCH_SCRIPT } from './updater-mac-relaunch.js';

const execFileP = promisify(execFile);

/** Poll the GitHub Releases API directly (see module header for why). */
export async function checkForUpdatesMac(opts: CheckOpts): Promise<UpdateInfo | null> {
  let json: {
    tag_name?: string;
    html_url?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  try {
    const res = await fetch(LATEST_URL, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } });
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
    if (getAvailableUpdate()) setUpdateState({ available: null });
    if (opts.notifyOnResult) {
      notify("You're up to date", `Claude Quota Monitor v${current} is the latest version.`);
    }
    return null;
  }

  const asset = pickAsset(json.assets ?? []);
  const available: UpdateInfo = {
    version: remote,
    tag,
    htmlUrl: String(json.html_url ?? `https://github.com/${OWNER}/${REPO}/releases/latest`),
    assetUrl: asset?.url ?? null,
    assetName: asset?.name ?? null,
  };
  setUpdateState({ available });
  if (opts.notifyOnUpdate) {
    notify('Update available', `Claude Quota Monitor ${tag} is ready — click to install.`, () =>
      void downloadAndInstallMac(),
    );
  }
  return available;
}

/**
 * Install the downloaded .dmg in place and relaunch — no Finder drag, no
 * "replace?"/"in use" dialogs. Mounts the dmg, then hands a detached helper the
 * job of swapping the bundle once we quit. Returns true if the relauncher was
 * launched (app is about to quit); false to fall back to opening the dmg.
 */
async function applyDmg(dmgPath: string): Promise<boolean> {
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

  notify('Installing update', `Updating to ${getAvailableUpdate()?.tag ?? 'the latest version'} and restarting…`);

  setUpdateState({ installing: true });
  spawn('/bin/bash', [scriptPath, String(process.pid), srcApp, appBundle, staging, mount, dmgPath, scriptPath], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  // Let the notification render, then quit so the helper can swap the
  // (no-longer-running) bundle and relaunch the new version.
  setTimeout(() => app.quit(), 500);
  return true;
}

/** Download the available .dmg, install it in place, and relaunch. */
export async function downloadAndInstallMac(): Promise<void> {
  const info = getAvailableUpdate();
  if (!info || isDownloading() || isInstalling()) return;

  // No installer asset for this platform → just open the release page.
  if (!info.assetUrl) {
    await shell.openExternal(info.htmlUrl);
    return;
  }

  setUpdateState({ downloading: true });
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
    if (await applyDmg(filePath)) return;

    // Fallback (not packaged / no write access / unexpected layout): hand the
    // downloaded installer to the OS so the user can finish manually.
    notify('Update downloaded', 'Opening the installer — drag the app into Applications to finish.');
    await shell.openPath(filePath);
  } catch {
    // Last resort: open the release page so the user can grab it manually.
    notify('Update failed', 'Opening the release page so you can download it manually.');
    await shell.openExternal(info.htmlUrl);
  } finally {
    setUpdateState({ downloading: false });
  }
}
