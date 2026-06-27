import { Notification, dialog } from 'electron';

import { addAccount, loadRegistry, removeAccount } from '../registry.js';
import { probeClaudeHealth, repairClaude, type ClaudeHealth } from '../claude-health.js';
import type { AppContext } from '../context.js';

/** Cross-module actions repair needs, injected by main.ts. */
export interface RepairDeps {
  /** Bring the popover back after a modal dialog hid it. */
  showWindow(): void;
}

export interface RepairController {
  /** True when `claude` is healthy (or was just repaired); offers a fix if not. */
  ensureClaudeHealthy(progressLabel?: string): Promise<boolean>;
  /** Start a login only if claude is healthy; otherwise offer to repair first. */
  tryStartLogin(label: string, configDir: string): Promise<boolean>;
  /** Tray "Repair / update Claude Code" — manual trigger with a confirm. */
  repairClaudeMenu(): Promise<void>;
  /** Tray "Add account…" — register, start sign-in, surface the login view. */
  addAccountFlow(): Promise<void>;
  /** Tray "Delete all accounts…" — confirm, then remove every account. */
  deleteAllAccountsFlow(): Promise<void>;
  /** Launch-time probe: flag a broken/missing claude binary via notification. */
  startupHealthCheck(): void;
}

// Everything here drives the `claude` binary, so when it's broken (e.g. a
// truncated update that macOS SIGKILLs on launch) the user just sees logins
// fail with a cryptic "exit 0". Probe it and offer a one-click reinstall of the
// latest version instead. Health is cached briefly so one gesture probes once.
export function createRepair(ctx: AppContext, deps: RepairDeps): RepairController {
  let healthCache: { at: number; health: ClaudeHealth } | null = null;
  let repairing = false;

  const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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
      ctx.send('login-status', { label: progressLabel, status: 'updating Claude Code (downloading ~216 MB)' });
    }
    const result = await repairClaude((line) => console.log('[repair]', line));
    healthCache = { at: Date.now(), health: result.health };
    repairing = false;
    if (result.ok) {
      note('Claude Code updated', `Now on v${result.health.version}. You can sign in.`);
      if (progressLabel) {
        ctx.send('login-status', { label: progressLabel, status: 'Claude Code updated — starting sign-in' });
        deps.showWindow(); // the repair dialog hid the popover — bring it back so sign-in is visible
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

  async function tryStartLogin(label: string, configDir: string): Promise<boolean> {
    if (ctx.logins.isActive(label)) return true;
    if (!(await ensureClaudeHealthy(label))) return false;
    ctx.logins.start(label, configDir);
    return true;
  }

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
      deps.showWindow();
      ctx.send('account-added', { label: acc.label }); // renderer opens the login view
    } catch (err) {
      console.error('add account failed:', errMsg(err));
    }
  }

  async function deleteAllAccountsFlow(): Promise<void> {
    const accounts = loadRegistry();
    if (accounts.length === 0) return;
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: `Delete all ${accounts.length} accounts?`,
      detail:
        'This removes every account from the monitor and deletes its local session. This cannot be undone.',
      buttons: ['Delete all', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    for (const acc of accounts) {
      ctx.logins.stop(acc.label);
      removeAccount(acc.label);
      ctx.lastResults.delete(acc.label);
    }
    ctx.updateBadge();
    ctx.send('accounts-changed', {}); // renderer reloads its list
    deps.showWindow();
  }

  function startupHealthCheck(): void {
    // Proactively flag a broken/missing claude binary (the app is useless without
    // it). A click on the notification opens the one-click repair.
    void getHealth().then((h) => {
      if (h.ok || !Notification.isSupported()) return;
      const n = new Notification({ title: 'Claude Code needs attention', body: `${cap(h.detail)}. Click to fix.` });
      n.on('click', () => void ensureClaudeHealthy());
      n.show();
    });
  }

  return {
    ensureClaudeHealthy,
    tryStartLogin,
    repairClaudeMenu,
    addAccountFlow,
    deleteAllAccountsFlow,
    startupHealthCheck,
  };
}
