import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Request/response channels the renderer may invoke (replaces the old HTTP routes).
const INVOKE = new Set([
  'accounts:list',
  'accounts:add',
  'accounts:remove',
  'accounts:reorder',
  'login:start',
  'login:stop',
  'login:code',
  'usage:check',
  'cli:open',
  'vscode:switch',
  'shell:openExternal',
  'win:resize',
  'lan:lend-start',
  'lan:lend-stop',
  'lan:discover',
  'lan:receive',
]);

// Push channels the main process emits (replaces the old WebSocket messages).
// Same payload shape as before, minus the `type` field.
const EVENTS = new Set([
  'login-status',
  'login-url',
  'login-success',
  'login-exit',
  'usage-status',
  'usage-result',
  'check-start',
  'check-done',
  'account-added',
  'lan-lend-status',
]);

contextBridge.exposeInMainWorld('api', {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  /** Subscribe to a push event; returns an unsubscribe fn. */
  on(channel: string, cb: (data: unknown) => void): () => void {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
