// Talk to the Electron main process over IPC (replaces fetch to the old server).

/**
 * Invoke a request/response IPC channel. Strips Electron's
 * "Error invoking remote method '…':" prefix for clean error messages.
 */
export async function invoke(channel, payload) {
  try {
    return await window.api.invoke(channel, payload);
  } catch (err) {
    const m = String(err && err.message ? err.message : err);
    throw new Error(m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
  }
}

/** Subscribe to a main→renderer push channel; returns an unsubscribe fn. */
export function on(channel, cb) {
  return window.api.on(channel, cb);
}
