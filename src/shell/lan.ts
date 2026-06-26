import { serializeAccount } from '../lan-transfer.js';
import { startLendServer, type LendSession } from '../lan-server.js';
import { receiveAccount } from '../lan-client.js';
import type { AppContext } from '../context.js';

// Thin Electron-side controller for LAN account lending. Owns the single active
// lend session (only one at a time — the user is watching one PIN) and pushes
// its outcome to the renderer via ctx.send. The transfer logic lives in the
// Node-pure core (lan-transfer/server/client); this holds state + bridges to UI.

export interface LanController {
  /** Begin lending `label`; resolves with the PIN + address to display. */
  lendStart(label: string): Promise<{ pin: string; host: string; port: number }>;
  /** Cancel the active lend window (no-op if none). */
  lendStop(): { ok: boolean };
  /** Pull an account from a lending PC and register it locally. */
  receive(host: string, port: number, pin: string): Promise<{ label: string }>;
}

export function createLan(ctx: AppContext): LanController {
  let session: LendSession | null = null;

  const clear = () => {
    session?.stop();
    session = null;
  };

  return {
    async lendStart(label) {
      clear(); // replace any prior window
      const transfer = serializeAccount(label); // may prompt macOS Keychain; may throw
      session = await startLendServer({
        transfer,
        onOutcome: (outcome, message) => {
          session = null;
          ctx.send('lan-lend-status', { state: outcome, message });
        },
      });
      return { pin: session.pin, host: session.host, port: session.port };
    },

    lendStop() {
      clear();
      return { ok: true };
    },

    async receive(host, port, pin) {
      const acc = await receiveAccount(host, port, pin);
      return { label: acc.label };
    },
  };
}
