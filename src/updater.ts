// ── Auto-update (notify + one-click download) ────────────────────────────────
// The app is ad-hoc signed, not notarized, so Squirrel.Mac-style silent in-place
// updates aren't reliable (every build gets a different signing identity). Instead
// we poll the GitHub Releases API, and when a newer version exists we surface it
// in the tray menu + a native notification. One click downloads the new .dmg and
// opens it, so the only manual step left is the final drag-to-Applications.
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app, Notification, shell } from 'electron';

// The GitHub repo that publishes releases (see .github/workflows/release.yml).
const OWNER = 'namdseasygoingvn';
const REPO = 'claude-multi-account';
const LATEST_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const UA = `${REPO}-updater`;

export interface UpdateInfo {
  version: string; // semver without the leading "v", e.g. "0.1.50"
  tag: string; // the release tag, e.g. "v0.1.50"
  htmlUrl: string; // release page (fallback if no .dmg asset is found)
  dmgUrl: string | null; // direct download URL of the matching .dmg
}

let available: UpdateInfo | null = null;
let downloading = false;
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

/** Pick the .dmg asset matching this Mac's architecture (falls back to any .dmg). */
function pickDmg(assets: Array<{ name?: string; browser_download_url?: string }>): string | null {
  const dmgs = assets.filter((a) => a.name?.toLowerCase().endsWith('.dmg'));
  if (dmgs.length === 0) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const alt = arch === 'x64' ? 'x86_64' : 'aarch64';
  const match = dmgs.find((a) => {
    const n = a.name!.toLowerCase();
    return n.includes(arch) || n.includes(alt);
  });
  return (match ?? dmgs[0]).browser_download_url ?? null;
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

  available = {
    version: remote,
    tag,
    htmlUrl: String(json.html_url ?? `https://github.com/${OWNER}/${REPO}/releases/latest`),
    dmgUrl: pickDmg(json.assets ?? []),
  };
  onChange?.();
  if (opts.notifyOnUpdate) {
    notify('Update available', `Claude Quota Monitor ${tag} is ready — click to download.`, () =>
      void downloadAndInstall(),
    );
  }
  return available;
}

/** Download the new .dmg and open it (mounts it → drag-to-Applications window). */
export async function downloadAndInstall(): Promise<void> {
  const info = available;
  if (!info || downloading) return;

  // No .dmg asset (shouldn't happen) → just open the release page.
  if (!info.dmgUrl) {
    await shell.openExternal(info.htmlUrl);
    return;
  }

  downloading = true;
  onChange?.();
  try {
    const dest = path.join(app.getPath('downloads'), `ClaudeQuotaMonitor-${info.version}.dmg`);
    const res = await fetch(info.dmgUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    // Bridge the web ReadableStream from fetch() to a Node stream for piping.
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
    notify('Update downloaded', 'Opening the installer — drag the app into Applications to finish.');
    await shell.openPath(dest);
  } catch {
    // Fall back to the release page so the user can grab it manually.
    notify('Download failed', 'Opening the release page so you can download it manually.');
    await shell.openExternal(info.htmlUrl);
  } finally {
    downloading = false;
    onChange?.();
  }
}
