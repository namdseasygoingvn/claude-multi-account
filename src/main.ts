import { app } from 'electron';

import { setupEnvironment } from './bootstrap.js';
import { setDataRoot } from './paths.js';
import { LoginManager } from './logins.js';
import { checkForUpdates, getUpdateSnapshot, onUpdateStateChange } from './updater.js';
import { createContext } from './context.js';
import { runUsageCheck as runUsageCheckImpl } from './usage-orchestrator.js';
import { createWindowController } from './shell/window.js';
import { createTray } from './shell/tray.js';
import { createRepair } from './shell/repair.js';
import { createLan } from './shell/lan.js';
import { registerIpc } from './shell/ipc.js';

// Restore the login-shell PATH and pin CLAUDE_BIN before anything spawns `claude`.
setupEnvironment();

// Single instance: a second launch just surfaces the running popover.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// A packaged .app can't write next to its read-only app.asar — redirect mutable
// data (accounts.json, accounts/, .scratch/) to userData. In dev, keep the repo
// root so existing accounts.json keeps working.
if (app.isPackaged) setDataRoot(app.getPath('userData'));

// ── Wire the engine ───────────────────────────────────────────────────────────
// Shared state + the LoginManager (its callbacks push login events to the UI).
const ctx = createContext(
  (c) =>
    new LoginManager({
      onSnapshot: () => {}, // raw PTY snapshots aren't shown in this UI
      onUrl: (label, url) => c.send('login-url', { label, url }),
      onStatus: (label, status) => c.send('login-status', { label, status }),
      onSuccess: (label, email) => c.send('login-success', { label, email }),
      onExit: (label, exitCode) => c.send('login-exit', { label, exitCode }),
    }),
);

const runUsageCheck = (labels?: string[]) => runUsageCheckImpl(ctx, labels);

const lan = createLan(ctx);
const windowCtl = createWindowController(ctx);
const repair = createRepair(ctx, { showWindow: () => windowCtl.show() });
const trayCtl = createTray(ctx, {
  addAccount: () => void repair.addAccountFlow(),
  repairClaude: () => void repair.repairClaudeMenu(),
  toggleWindow: () => windowCtl.toggle(),
  shareAllAccounts: () => {
    windowCtl.show();
    ctx.send('lan-share-all', {});
  },
  receiveAccount: () => {
    windowCtl.show();
    ctx.send('lan-receive', {});
  },
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.on('second-instance', () => windowCtl.show());

// Push every update state change to the popover so its update row stays live
// (the renderer also fetches an initial snapshot on load via 'update:state').
onUpdateStateChange(() => ctx.send('update-state', getUpdateSnapshot()));

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide(); // menu-bar-only app
  registerIpc(ctx, {
    runUsageCheck,
    tryStartLogin: repair.tryStartLogin,
    resizeWindow: (h) => windowCtl.resize(h),
    lan,
  });
  windowCtl.create();
  trayCtl.create();

  // Auto-update: only in a packaged build (in dev getVersion() is the stale
  // 0.1.0, which would always look out of date). Check on launch, then every 6h.
  if (app.isPackaged) {
    void checkForUpdates({ notifyOnUpdate: true });
    setInterval(() => void checkForUpdates({ notifyOnUpdate: true }), 6 * 60 * 60 * 1000);
  }

  repair.startupHealthCheck();
});

// Menu-bar app: closing the popover must NOT quit the app.
app.on('window-all-closed', () => {
  /* stay resident in the menu bar */
});

app.on('before-quit', () => ctx.logins.stopAll());

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    ctx.logins.stopAll();
    app.quit();
  });
}
