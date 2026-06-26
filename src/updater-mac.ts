// ── macOS auto-update — DIY .dmg swap ─────────────────────────────────────────
// There's no code-signing cert in CI, and Squirrel.Mac refuses to apply unsigned
// updates, so electron-updater can't help here. Instead we poll the Releases API,
// download the .dmg ourselves (reporting progress to the popover), then mount it
// and swap the .app bundle in place + relaunch (see updater-mac-apply). Because
// the app (not a browser) fetched the .dmg, the swapped bundle carries no
// quarantine flag, so the relaunch also skips Gatekeeper.
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app, shell } from 'electron';
import {
  cmpVersion,
  flashUpToDate,
  getAvailableUpdate,
  isDownloading,
  isInstalling,
  isReady,
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
import { applyDmg } from './updater-mac-apply.js';

// Path of the .dmg we've fully downloaded and staged, ready for installUpdateMac.
let stagedDmg: string | null = null;

/** Poll the GitHub Releases API directly (see module header for why). */
export async function checkForUpdatesMac(opts: CheckOpts): Promise<UpdateInfo | null> {
  setUpdateState({ checking: true, error: null, upToDate: false });
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
    setUpdateState({ checking: false, error: 'Update check failed' });
    if (opts.notifyOnResult) {
      notify('Update check failed', "Couldn't reach GitHub. Check your connection and try again.");
    }
    return null;
  }

  const tag = String(json.tag_name ?? '');
  const remote = tag.replace(/^v/, '');
  const current = app.getVersion();

  if (!remote || cmpVersion(remote, current) <= 0) {
    setUpdateState({ checking: false, available: null, ready: false });
    if (opts.notifyOnResult) {
      flashUpToDate();
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
  setUpdateState({ checking: false, available });
  if (opts.notifyOnUpdate) {
    notify('Update available', `Claude Quota Monitor ${tag} is ready to download.`);
  }
  return available;
}

/**
 * Download the available .dmg to a temp file, reporting progress to the popover.
 * On success the file is staged (stagedDmg) and the UI flips to "ready" — the
 * actual bundle swap waits for installUpdateMac(). No installer asset for this
 * platform → just open the release page.
 */
export async function downloadUpdateMac(): Promise<void> {
  const info = getAvailableUpdate();
  if (!info || isDownloading() || isInstalling() || isReady()) return;

  if (!info.assetUrl) {
    await shell.openExternal(info.htmlUrl);
    return;
  }

  setUpdateState({ downloading: true, progress: 0, error: null });
  try {
    // Keep the published filename (it encodes the arch + "-setup"); fall back to
    // a platform-correct extension if the API somehow omitted the name.
    const fileName = info.assetName || `ClaudeQuotaMonitor-${info.version}.dmg`;
    const filePath = path.join(os.tmpdir(), fileName);
    const res = await fetch(info.assetUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);

    // Bridge the web ReadableStream to a Node stream, counting bytes so the
    // popover can show a live percentage (Content-Length permitting).
    const total = Number(res.headers.get('content-length')) || 0;
    let seen = 0;
    let lastPct = 0;
    const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    src.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (total <= 0) return;
      const pct = Math.min(99, Math.round((seen / total) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        setUpdateState({ progress: pct }); // only on whole-% change — the data event is per-chunk
      }
    });
    await pipeline(src, createWriteStream(filePath));

    stagedDmg = filePath;
    setUpdateState({ downloading: false, progress: 100, ready: true });
    notify('Update ready', `Claude Quota Monitor ${info.tag} is ready — restart to install.`, () =>
      void installUpdateMac(),
    );
  } catch {
    setUpdateState({ downloading: false, progress: null, error: 'Download failed' });
    notify('Update failed', 'Opening the release page so you can download it manually.');
    await shell.openExternal(info.htmlUrl);
  }
}

/** Install the staged .dmg in place and relaunch (downloading first if needed). */
export async function installUpdateMac(): Promise<void> {
  if (isInstalling()) return;
  if (!stagedDmg) {
    await downloadUpdateMac();
    if (!stagedDmg) return;
  }

  // Preferred: install it ourselves and relaunch — no Finder dialogs.
  if (await applyDmg(stagedDmg)) return;

  // Fallback (not packaged / no write access / unexpected layout): hand the
  // downloaded installer to the OS so the user can finish manually.
  setUpdateState({ installing: false });
  notify('Update downloaded', 'Opening the installer — drag the app into Applications to finish.');
  await shell.openPath(stagedDmg).catch(async () => {
    await unlink(stagedDmg!).catch(() => {});
  });
}
