// Shared core for the auto-updater: the cross-platform update state plus the
// small helpers both platform flows lean on. The platform modules
// (`updater-windows`, `updater-mac`) own their own install logic but read and
// mutate THIS module's state through the accessors below, so the single source
// of truth (and the lone onChange subscriber) lives in one place.
import { Notification, shell } from 'electron';

// The GitHub repo that publishes releases (see .github/workflows/release.yml).
export const OWNER = 'namdseasygoingvn';
export const REPO = 'claude-multi-account';
export const LATEST_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
export const UA = `${REPO}-updater`;

export interface UpdateInfo {
  version: string; // semver without the leading "v", e.g. "0.1.50"
  tag: string; // the release tag, e.g. "v0.1.50"
  htmlUrl: string; // release page (fallback if no matching asset is found)
  assetUrl: string | null; // direct download URL of THIS platform's installer (.dmg / .exe)
  assetName: string | null; // its filename — drives the temp path + which install flow runs
}

export interface CheckOpts {
  /** Show a notification when an update is found (auto checks + manual). */
  notifyOnUpdate?: boolean;
  /** Also notify "up to date" / "couldn't check" (manual checks only). */
  notifyOnResult?: boolean;
}

// ── Shared mutable state ──────────────────────────────────────────────────────
const state = {
  available: null as UpdateInfo | null,
  checking: false, // a check is in flight (manual or auto)
  downloading: false,
  progress: null as number | null, // download progress 0–100 (null = unknown/none)
  ready: false, // downloaded + staged — ready to restart & install
  installing: false, // a relaunch has been scheduled — block re-entry
  error: null as string | null, // last check/download failure, for the UI
};
let onChange: (() => void) | null = null;

/** Current update for the tray menu (null = none known). */
export function getAvailableUpdate(): UpdateInfo | null {
  return state.available;
}
export function isDownloading(): boolean {
  return state.downloading;
}
export function isInstalling(): boolean {
  return state.installing;
}
export function isReady(): boolean {
  return state.ready;
}
/** Called whenever update/download state changes, so the caller can refresh UI. */
export function onUpdateStateChange(cb: () => void): void {
  onChange = cb;
}

/** Update a slice of state and notify the subscriber (if any) in one step. */
export function setUpdateState(patch: Partial<typeof state>): void {
  Object.assign(state, patch);
  onChange?.();
}

// ── Renderer snapshot ─────────────────────────────────────────────────────────
// The popover's update row is driven entirely by this single derived snapshot,
// pushed on every state change (see main.ts wiring → 'update-state' IPC event).
export type UpdatePhase =
  | 'idle' // no update known — offer "Check for updates"
  | 'checking' // a check is running — dim + "Checking…"
  | 'available' // newer version found — offer "Download vX.Y.Z"
  | 'downloading' // fetching the installer — show a text progress bar
  | 'ready' // downloaded + staged — offer "Restart to update"
  | 'installing' // relaunch scheduled — "Updating…"
  | 'error'; // last check/download failed — offer to retry

export interface UpdateSnapshot {
  phase: UpdatePhase;
  version: string | null;
  tag: string | null;
  progress: number | null;
  error: string | null;
}

/** Collapse the mutable state into the one phase the renderer renders. */
export function getUpdateSnapshot(): UpdateSnapshot {
  const phase: UpdatePhase = state.installing
    ? 'installing'
    : state.downloading
      ? 'downloading'
      : state.ready
        ? 'ready'
        : state.available
          ? 'available'
          : state.checking
            ? 'checking'
            : state.error
              ? 'error'
              : 'idle';
  return {
    phase,
    version: state.available?.version ?? null,
    tag: state.available?.tag ?? null,
    progress: state.progress,
    error: state.error,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The releases page for the available update, or the generic latest page. */
export function releaseUrl(): string {
  return state.available?.htmlUrl ?? `https://github.com/${OWNER}/${REPO}/releases/latest`;
}

/** Compare dotted numeric versions. >0 if a is newer than b. */
export function cmpVersion(a: string, b: string): number {
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
export function pickAsset(
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

/** Fire a desktop notification (with an optional click handler). */
export function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
}

/** A "couldn't install — download manually" notification used by both flows. */
export function notifyInstallFailed(err?: unknown): void {
  const detail = String((err as Error)?.message ?? err ?? '').slice(0, 140);
  notify(
    'Update failed',
    `Couldn't install automatically${detail ? ` (${detail})` : ''}. Click to download it manually.`,
    () => void shell.openExternal(releaseUrl()),
  );
}
