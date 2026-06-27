import { app } from 'electron';

import { setupEnvironment } from './bootstrap.js';
import { setDataRoot } from './paths.js';
import { LoginManager } from './logins.js';
import { checkForUpdates, getUpdateSnapshot, onUpdateStateChange } from './updater.js';
import { appendLog, attachRendererLog, patchMainConsole } from './log-buffer.js';
import { createContext } from './context.js';
import { runUsageCheck as runUsageCheckImpl } from './usage-orchestrator.js';
import { createWindowController } from './shell/window.js';
import { createTray } from './shell/tray.js';
import { createRepair } from './shell/repair.js';
import { createLan } from './shell/lan.js';
import { registerIpc } from './shell/ipc.js';

// Safety net FIRST: this app drives `claude` over PTYs, and node-pty's Windows
// backend (ConPTY) can throw ASYNCHRONOUSLY — after spawn returns — when a pipe
// breaks (the claude.cmd shim exiting oddly, a closed handle, an EPIPE on write).
// Such a throw doesn't surface at the try/catch around the spawn/write/kill call;
// it bubbles up as an uncaught exception. Without this guard it kills the main
// process, and the popover BrowserWindow dies with it — the recurring "panel
// dies when an account fails to load" bug, which only ever reproduced on Windows
// because macOS's forkpty doesn't hit this path. A monitor must stay resident
// through any single account's failure, so we log and swallow instead of exiting.
// Mirror into the tray debug log buffer too, so a main-process crash that would
// have blanked the window is visible there without a DevTools session.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  appendLog('main:uncaught', err instanceof Error ? (err.stack ?? err.message) : String(err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  appendLog('main:unhandled', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});

// Windows: force CPU (SwiftShader) compositing. The popover renderer kept dying
// with `render-process-gone:crashed exit=-36861` a few seconds into every load —
// a *native* crash (it never reached the JS window.onerror handler), Windows-only
// (macOS was fine), and deterministic while the check's spinner animation + SVG
// icons were actively compositing. That signature is a GPU-process death (driver
// TDR / device-removed) taking the renderer with it; it's independent of the
// content, which is why the resize-storm fix and a fresh install didn't touch it.
// This tiny popover doesn't need the GPU, so software compositing is a clean
// trade. macOS keeps hardware accel — its vibrancy backing relies on it and never
// crashed. MUST be called before app is ready.
if (process.platform === 'win32') app.disableHardwareAcceleration();

// Restore the login-shell PATH and pin CLAUDE_BIN before anything spawns `claude`.
setupEnvironment();
patchMainConsole(); // capture console.log/warn/error into the debug ring buffer

// Diagnostic: if the GPU process itself dies, log it (the renderer's own death is
// already logged in window.ts). Confirms the crash class above and stays useful
// even with hardware accel off, since other child processes report here too.
app.on('child-process-gone', (_e, details) => {
  appendLog('main:child-gone', `${details.type} ${details.reason} exit=${details.exitCode}`);
});

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
  if (ctx.win) attachRendererLog(ctx.win);
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
