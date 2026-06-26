import { ipcMain, shell } from 'electron';

import {
  addAccount,
  getAccount,
  isValidLabel,
  loadRegistry,
  probeLogin,
  removeAccount,
  reorderAccounts,
} from '../registry.js';
import { getActiveVSCodeLabel, openCli, switchVSCode } from '../switcher.js';
import type { AppContext } from '../context.js';
import type { LanController } from './lan.js';
import type { AccountStatus, UsageResult } from '../types.js';

/** Cross-module actions the IPC layer delegates to, injected by main.ts. */
export interface IpcDeps {
  runUsageCheck(labels?: string[]): Promise<UsageResult[]>;
  tryStartLogin(label: string, configDir: string): Promise<boolean>;
  /** Fit the popover to a measured content height (geometry lives in window.ts). */
  resizeWindow(height: number): void;
  /** LAN account lending (lend server + receive client). */
  lan: LanController;
}

/** Register every renderer-callable IPC handler (replaces the old express routes). */
export function registerIpc(ctx: AppContext, deps: IpcDeps): void {
  let uiConnected = false; // flips on the renderer's first IPC call (sanity check)

  const statusOf = (label: string): AccountStatus | null => {
    const acc = getAccount(label);
    if (!acc) return null;
    return { ...acc, ...probeLogin(acc), loginActive: ctx.logins.isActive(acc.label) };
  };

  ipcMain.handle('accounts:list', () => {
    if (!uiConnected) {
      uiConnected = true;
      console.log('[cqm] UI connected (renderer ↔ main IPC working)');
    }
    return {
      accounts: loadRegistry().map((acc) => ({
        ...acc,
        ...probeLogin(acc),
        loginActive: ctx.logins.isActive(acc.label),
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
    const started = await deps.tryStartLogin(acc.label, acc.configDir);
    return { account: statusOf(acc.label), blocked: !started };
  });

  ipcMain.handle('accounts:remove', (_e, payload: { label: string }) => {
    if (!getAccount(payload.label)) throw new Error(`unknown account "${payload.label}"`);
    ctx.logins.stop(payload.label);
    removeAccount(payload.label);
    ctx.lastResults.delete(payload.label);
    ctx.updateBadge();
    return { ok: true };
  });

  ipcMain.handle('accounts:reorder', (_e, payload: { labels?: string[] } = {}) => {
    const labels = Array.isArray(payload?.labels) ? payload.labels.filter((l) => typeof l === 'string') : [];
    reorderAccounts(labels);
    return { ok: true };
  });

  ipcMain.handle('login:start', async (_e, payload: { label: string }) => {
    const acc = getAccount(payload.label);
    if (!acc) throw new Error(`unknown account "${payload.label}"`);
    const alreadyActive = ctx.logins.isActive(acc.label);
    const started = await deps.tryStartLogin(acc.label, acc.configDir);
    return { account: statusOf(acc.label), alreadyActive, blocked: !started };
  });

  ipcMain.handle('login:stop', (_e, payload: { label: string }) => ({
    stopped: ctx.logins.stop(payload.label),
  }));

  ipcMain.handle('login:code', (_e, payload: { label: string; code: string }) => {
    const code = typeof payload?.code === 'string' ? payload.code.trim() : '';
    if (!code) throw new Error('body must be { code: string }');
    if (!ctx.logins.write(payload.label, code + '\r')) {
      throw new Error('no active sign-in session for this account');
    }
    return { ok: true };
  });

  ipcMain.handle('usage:check', async (_e, payload: { labels?: string[] } = {}) => ({
    results: await deps.runUsageCheck(payload?.labels),
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

  ipcMain.handle('lan:lend-start', (_e, payload: { labels?: string[] } = {}) => {
    const labels = (Array.isArray(payload?.labels) ? payload.labels : []).filter((l) => typeof l === 'string');
    if (labels.length === 0) throw new Error('no accounts to lend');
    for (const l of labels) if (!getAccount(l)) throw new Error(`unknown account "${l}"`);
    return deps.lan.lendStart(labels);
  });

  ipcMain.handle('lan:lend-stop', () => deps.lan.lendStop());

  ipcMain.handle('lan:discover', () => deps.lan.discover());

  ipcMain.handle('lan:receive', (_e, payload: { host: string; port: number; pin: string }) => {
    const host = typeof payload?.host === 'string' ? payload.host.trim() : '';
    const port = Number(payload?.port);
    const pin = typeof payload?.pin === 'string' ? payload.pin.trim() : '';
    if (!host || !Number.isInteger(port) || port <= 0) throw new Error('enter an address as host:port');
    return deps.lan.receive(host, port, pin);
  });

  ipcMain.handle('shell:openExternal', (_e, payload: { url: string }) => {
    if (/^https?:/.test(payload?.url ?? '')) void shell.openExternal(payload.url);
    return { ok: true };
  });

  // The renderer measures its content and asks us to fit the popover to it
  // (capped at ~5 accounts; taller content scrolls). The window controller owns
  // the geometry — it caps the height and re-anchors the popover to the tray.
  ipcMain.handle('win:resize', (_e, payload: { height: number }) => {
    deps.resizeWindow(Math.round(payload?.height ?? 0));
    return { ok: true };
  });
}
