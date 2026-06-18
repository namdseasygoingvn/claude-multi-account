import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell } from 'electron';
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
  return Menu.buildFromTemplate([
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

async function addAccountFlow(): Promise<void> {
  try {
    const acc = addAccount();
    logins.start(acc.label, acc.configDir);
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
    height: 560,
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
    };
  });

  ipcMain.handle('accounts:add', (_e, payload: { label?: string } = {}) => {
    const raw = typeof payload?.label === 'string' ? payload.label.trim() : '';
    if (raw && !isValidLabel(raw)) {
      throw new Error('label must be 1–32 chars: letters, digits, dot, dash, underscore');
    }
    const acc = addAccount(raw || undefined);
    logins.start(acc.label, acc.configDir);
    return { account: statusOf(acc.label) };
  });

  ipcMain.handle('accounts:remove', (_e, payload: { label: string }) => {
    if (!getAccount(payload.label)) throw new Error(`unknown account "${payload.label}"`);
    logins.stop(payload.label);
    removeAccount(payload.label);
    lastResults.delete(payload.label);
    updateBadge();
    return { ok: true };
  });

  ipcMain.handle('login:start', (_e, payload: { label: string }) => {
    const acc = getAccount(payload.label);
    if (!acc) throw new Error(`unknown account "${payload.label}"`);
    const alreadyActive = logins.isActive(acc.label);
    if (!alreadyActive) logins.start(acc.label, acc.configDir);
    return { account: statusOf(acc.label), alreadyActive };
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

  ipcMain.handle('shell:openExternal', (_e, payload: { url: string }) => {
    if (/^https?:/.test(payload?.url ?? '')) void shell.openExternal(payload.url);
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
