import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } from 'electron';
import fixPath from 'fix-path';

import { REPO_ROOT, setDataRoot } from './paths.js';
import {
  addAccount,
  getAccount,
  isValidLabel,
  loadRegistry,
  probeLogin,
  removeAccount,
} from './registry.js';
import { LoginManager } from './logins.js';
import { checkUsage } from './usage.js';
import {
  checkForUpdates,
  downloadAndInstall,
  getAvailableUpdate,
  isDownloading,
} from './updater.js';
import { probeClaudeHealth, repairClaude, type ClaudeHealth } from './claude-health.js';
import { openCli, switchVSCode, getActiveVSCodeLabel } from './switcher.js';
import type { AccountStatus, UsageResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Environment fixups ─────────────────────────────────────────────────────
// Apps launched from Finder get a minimal PATH (no Homebrew/nvm/~/.local/bin),
// so the bundled `claude` lookup would fail. Restore the user's login-shell PATH.
fixPath();

/** Resolve the real `claude` binary (a shell *function* shadows it interactively). */
function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const out = execSync('command -v claude', { shell: '/bin/bash', encoding: 'utf8' }).trim();
    if (out) return out;
  } catch {
    /* fall through to bare name on PATH */
  }
  return 'claude';
}
process.env.CLAUDE_BIN = resolveClaudeBin();

// A packaged .app can't write next to its read-only app.asar — redirect mutable
// data (accounts.json, accounts/, .scratch/) to userData. In dev, keep the repo
// root so existing accounts.json keeps working.
if (app.isPackaged) setDataRoot(app.getPath('userData'));

// ── Single instance ─────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let uiConnected = false; // flips on the renderer's first IPC call (sanity check)
let autoTimer: NodeJS.Timeout | null = null;
let autoMinutes = 0; // 0 = off (tray-menu driven; the popover has its own toggle)

// Latest usage result per label — drives the menu-bar badge.
const lastResults = new Map<string, UsageResult>();
// Labels with an in-flight usage check (mirrors the old server-side guard).
const checking = new Set<string>();

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Engine wiring (unchanged modules, callbacks → IPC push) ──────────────────
const logins = new LoginManager({
  onSnapshot: () => {}, // raw PTY snapshots aren't shown in this UI
  onUrl: (label, url) => send('login-url', { label, url }),
  onStatus: (label, status) => send('login-status', { label, status }),
  onSuccess: (label, email) => send('login-success', { label, email }),
  onExit: (label, exitCode) => send('login-exit', { label, exitCode }),
});

function statusOf(label: string): AccountStatus | null {
  const acc = getAccount(label);
  if (!acc) return null;
  return { ...acc, ...probeLogin(acc), loginActive: logins.isActive(acc.label) };
}

/** Fan out /usage over the given labels (or all). Mirrors POST /api/usage/check. */
async function runUsageCheck(labels?: string[]): Promise<UsageResult[]> {
  const all = loadRegistry();
  const requested = labels && labels.length > 0 ? all.filter((a) => labels.includes(a.label)) : all;
  const targets = requested.filter((a) => !checking.has(a.label));
  if (targets.length === 0) return [];
  const labelsRun = targets.map((t) => t.label);
  for (const l of labelsRun) checking.add(l);
  send('check-start', { labels: labelsRun });
  try {
    return await Promise.all(
      targets.map((acc) =>
        checkUsage(acc, {
          onPhase: (phase) => send('usage-status', { label: acc.label, phase }),
        }).then((result) => {
          lastResults.set(result.label, result);
          send('usage-result', { result });
          updateBadge();
          return result;
        }),
      ),
    );
  } finally {
    for (const l of labelsRun) checking.delete(l);
    send('check-done', { labels: labelsRun });
  }
}

// ── Menu-bar (tray) ──────────────────────────────────────────────────────────
function trayImage(): Electron.NativeImage {
  const file = path.join(REPO_ROOT, 'assets', 'trayTemplate.png');
  const img = nativeImage.createFromPath(file);
  img.setTemplateImage(true); // macOS tints it for light/dark menu bars
  return img;
}

/** Worst-case usage % across accounts → a compact menu-bar readout. */
function updateBadge(): void {
  if (!tray) return;
  let worst: number | null = null;
  for (const r of lastResults.values()) {
    for (const s of r.parsed?.sections ?? []) {
      if (s.pct != null && (worst == null || s.pct > worst)) worst = s.pct;
    }
  }
  tray.setTitle(worst == null ? '' : ` ${worst}%`);
  const lines = [...lastResults.values()]
    .map((r) => {
      const top = r.parsed?.sections?.reduce<number | null>(
        (m, s) => (s.pct != null && (m == null || s.pct > m) ? s.pct : m),
        null,
      );
      return `${r.label}: ${top == null ? '—' : top + '%'}`;
    })
    .join(' · ');
  tray.setToolTip(lines ? `Claude Quota — ${lines}` : 'Claude Quota Monitor');
}

function buildContextMenu(): Electron.Menu {
  const intervals = [0, 5, 15, 30, 60];
  const update = getAvailableUpdate();
  const updateItem: Electron.MenuItemConstructorOptions = isDownloading()
    ? { label: 'Downloading update…', enabled: false }
    : update
      ? { label: `Install update ${update.tag} & restart`, click: () => void downloadAndInstall() }
      : {
          label: 'Check for updates',
          click: () => void checkForUpdates({ notifyOnUpdate: true, notifyOnResult: true }),
        };
  return Menu.buildFromTemplate([
    { label: `Claude Quota Monitor v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Check usage now', click: () => void runUsageCheck() },
    {
      label: 'Auto-refresh',
      submenu: intervals.map((m) => ({
        label: m === 0 ? 'Off' : `Every ${m} min`,
        type: 'radio' as const,
        checked: autoMinutes === m,
        click: () => setAutoRefresh(m),
      })),
    },
    { type: 'separator' },
    { label: 'Add account…', click: () => void addAccountFlow() },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    updateItem,
    { label: 'Repair / update Claude Code…', click: () => void repairClaudeMenu() },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

function setAutoRefresh(minutes: number): void {
  autoMinutes = minutes;
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (minutes > 0) autoTimer = setInterval(() => void runUsageCheck(), minutes * 60_000);
}

// ── Claude CLI health + self-repair ──────────────────────────────────────────
// Everything here drives the `claude` binary, so when it's broken (e.g. a
// truncated update that macOS SIGKILLs on launch) the user just sees logins
// fail with a cryptic "exit 0". Probe it and offer a one-click reinstall of the
// latest version instead. Health is cached briefly so one gesture probes once.
let healthCache: { at: number; health: ClaudeHealth } | null = null;
let repairing = false;

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function getHealth(maxAgeMs = 8_000): Promise<ClaudeHealth> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < maxAgeMs) return healthCache.health;
  const health = await probeClaudeHealth();
  healthCache = { at: now, health };
  return health;
}

/** Run the npm reinstall, surfacing progress via notifications (+ login modal if any). */
async function runRepair(progressLabel?: string): Promise<boolean> {
  if (repairing) return false;
  repairing = true;
  const note = (title: string, body: string): void => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  };
  note('Updating Claude Code', 'Downloading the latest version (~216 MB). This can take a minute.');
  if (progressLabel) {
    send('login-status', { label: progressLabel, status: 'updating Claude Code (downloading ~216 MB)' });
  }
  const result = await repairClaude((line) => console.log('[repair]', line));
  healthCache = { at: Date.now(), health: result.health };
  repairing = false;
  if (result.ok) {
    note('Claude Code updated', `Now on v${result.health.version}. You can sign in.`);
    if (progressLabel) {
      send('login-status', { label: progressLabel, status: 'Claude Code updated — starting sign-in' });
      showWindow(); // the repair dialog hid the popover — bring it back so sign-in is visible
    }
    return true;
  }
  await dialog.showMessageBox({
    type: 'error',
    message: "Couldn't update Claude Code automatically",
    detail: result.error ?? 'Unknown error.',
    buttons: ['OK'],
  });
  return false;
}

/**
 * Ensure `claude` is runnable; if not, offer a one-click repair. Returns true
 * when claude is healthy (or was just repaired). `progressLabel` routes repair
 * progress to that account's login modal.
 */
async function ensureClaudeHealthy(progressLabel?: string): Promise<boolean> {
  const health = await getHealth();
  if (health.ok) return true;
  if (repairing) return false;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Claude Code needs to be updated',
    detail:
      `${cap(health.detail)}.\n\n` +
      'This app signs in and checks usage through the `claude` command, which is not working right now. ' +
      'Update to the latest Claude Code? (~216 MB download.)',
    buttons: ['Update now', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  return runRepair(progressLabel);
}

/** Start a login only if claude is healthy; otherwise offer to repair first. */
async function tryStartLogin(label: string, configDir: string): Promise<boolean> {
  if (logins.isActive(label)) return true;
  if (!(await ensureClaudeHealthy(label))) return false;
  logins.start(label, configDir);
  return true;
}

/** Tray "Repair / update Claude Code" — manual trigger with a confirm. */
async function repairClaudeMenu(): Promise<void> {
  if (repairing) return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Update Claude Code now?',
    detail:
      'Reinstalls the latest Claude Code from npm (~216 MB). Use this if sign-in or usage checks stop working.',
    buttons: ['Update now', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await runRepair();
}

async function addAccountFlow(): Promise<void> {
  try {
    const acc = addAccount();
    if (!(await tryStartLogin(acc.label, acc.configDir))) return; // repair declined/failed
    showWindow();
    send('account-added', { label: acc.label }); // renderer opens the login view
  } catch (err) {
    console.error('add account failed:', errMsg(err));
  }
}

// ── Popover window ───────────────────────────────────────────────────────────
function createWindow(): void {
  win = new BrowserWindow({
    width: 340,
    height: 360, // initial only — the renderer fits the window to its content

    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    // `popover` is the frosted system menu/popover material (like the Wi-Fi
    // menu or the "Hot" app), not the darker `under-window` window material.
    vibrancy: 'popover',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      // ESM preload must use the .mjs extension or Electron loads it as CommonJS.
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required so the ESM preload can load
    },
  });

  void win.loadFile(path.join(REPO_ROOT, 'web', 'index.html'));

  // target=_blank / window.open (OAuth URLs, the repo link) → default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never let an in-app click navigate the popover away from the dashboard.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win!.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  // Popover dismiss: hide when focus leaves (unless devtools is open).
  win.on('blur', () => {
    if (win && !win.webContents.isDevToolsOpened()) win.hide();
  });
}

function positionWindow(): void {
  if (!win || !tray) return;
  const tb = tray.getBounds();
  const wb = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const area = display.workArea;
  let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - wb.width - 4));
  const y = Math.round(tb.y + tb.height + 4);
  win.setPosition(x, y, false);
}

function showWindow(): void {
  if (!win) return;
  positionWindow();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

// ── IPC handlers (replace the old express routes) ────────────────────────────
function registerIpc(): void {
  ipcMain.handle('accounts:list', () => {
    if (!uiConnected) {
      uiConnected = true;
      console.log('[cqm] UI connected (renderer ↔ main IPC working)');
    }
    return {
      accounts: loadRegistry().map((acc) => ({
        ...acc,
        ...probeLogin(acc),
        loginActive: logins.isActive(acc.label),
      })),
      activeVSCode: getActiveVSCodeLabel(),
    };
  });

  ipcMain.handle('accounts:add', async (_e, payload: { label?: string } = {}) => {
    const raw = typeof payload?.label === 'string' ? payload.label.trim() : '';
    if (raw && !isValidLabel(raw)) {
      throw new Error('label must be 1–32 chars: letters, digits, dot, dash, underscore');
    }
    const acc = addAccount(raw || undefined);
    const started = await tryStartLogin(acc.label, acc.configDir);
    return { account: statusOf(acc.label), blocked: !started };
  });

  ipcMain.handle('accounts:remove', (_e, payload: { label: string }) => {
    if (!getAccount(payload.label)) throw new Error(`unknown account "${payload.label}"`);
    logins.stop(payload.label);
    removeAccount(payload.label);
    lastResults.delete(payload.label);
    updateBadge();
    return { ok: true };
  });

  ipcMain.handle('login:start', async (_e, payload: { label: string }) => {
    const acc = getAccount(payload.label);
    if (!acc) throw new Error(`unknown account "${payload.label}"`);
    const alreadyActive = logins.isActive(acc.label);
    const started = await tryStartLogin(acc.label, acc.configDir);
    return { account: statusOf(acc.label), alreadyActive, blocked: !started };
  });

  ipcMain.handle('login:stop', (_e, payload: { label: string }) => ({
    stopped: logins.stop(payload.label),
  }));

  ipcMain.handle('login:code', (_e, payload: { label: string; code: string }) => {
    const code = typeof payload?.code === 'string' ? payload.code.trim() : '';
    if (!code) throw new Error('body must be { code: string }');
    if (!logins.write(payload.label, code + '\r')) {
      throw new Error('no active sign-in session for this account');
    }
    return { ok: true };
  });

  ipcMain.handle('usage:check', async (_e, payload: { labels?: string[] } = {}) => ({
    results: await runUsageCheck(payload?.labels),
  }));

  ipcMain.handle('cli:open', (_e, payload: { label: string }) => {
    if (!getAccount(payload.label)) throw new Error(`unknown account "${payload.label}"`);
    openCli(payload.label);
    return { ok: true };
  });

  ipcMain.handle('vscode:switch', (_e, payload: { label: string }) => {
    if (!getAccount(payload.label)) throw new Error(`unknown account "${payload.label}"`);
    return switchVSCode(payload.label);
  });

  ipcMain.handle('shell:openExternal', (_e, payload: { url: string }) => {
    if (/^https?:/.test(payload?.url ?? '')) void shell.openExternal(payload.url);
    return { ok: true };
  });

  // The renderer measures its content and asks us to fit the popover to it
  // (capped at ~5 accounts; taller content scrolls). Keep width fixed; clamp
  // the height so the window never runs past the bottom of the screen.
  ipcMain.handle('win:resize', (_e, payload: { height: number }) => {
    if (!win) return { ok: false };
    const [w] = win.getSize();
    const desired = Math.round(payload?.height ?? 0);
    if (!Number.isFinite(desired) || desired < 80) return { ok: false };
    const { y } = win.getBounds();
    const area = screen.getDisplayNearestPoint(win.getBounds()).workArea;
    const maxH = Math.max(200, area.y + area.height - y - 8);
    win.setSize(w, Math.min(desired, maxH), false);
    return { ok: true };
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide(); // menu-bar-only app
  registerIpc();
  createWindow();
  tray = new Tray(trayImage());
  tray.setToolTip('Claude Quota Monitor');
  tray.on('click', () => toggleWindow());
  tray.on('right-click', () => tray!.popUpContextMenu(buildContextMenu()));
  updateBadge();

  // Auto-update: only in a packaged build (in dev getVersion() is the stale
  // 0.1.0, which would always look out of date). Check on launch, then every 6h.
  if (app.isPackaged) {
    void checkForUpdates({ notifyOnUpdate: true });
    setInterval(() => void checkForUpdates({ notifyOnUpdate: true }), 6 * 60 * 60 * 1000);
  }

  // Proactively flag a broken/missing claude binary (the app is useless without
  // it). A click on the notification opens the one-click repair.
  void getHealth().then((h) => {
    if (h.ok || !Notification.isSupported()) return;
    const n = new Notification({ title: 'Claude Code needs attention', body: `${cap(h.detail)}. Click to fix.` });
    n.on('click', () => void ensureClaudeHealthy());
    n.show();
  });
});

// Menu-bar app: closing the popover must NOT quit the app.
app.on('window-all-closed', () => {
  /* stay resident in the menu bar */
});

app.on('before-quit', () => logins.stopAll());

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logins.stopAll();
    app.quit();
  });
}
