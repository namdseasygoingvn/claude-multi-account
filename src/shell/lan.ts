import { serializeAccount, type ApplyResult } from '../lan-transfer.js';
import { startLendServer, type LendSession } from '../lan-server.js';
import { receiveAccounts } from '../lan-client.js';
import { discover, startResponder, type DiscoveredPeer, type Responder } from '../lan-discovery.js';
import type { AppContext } from '../context.js';

// Electron-side controller for LAN account lending. Owns the single active lend
// session — its HTTP server plus the UDP discovery responder that lets the
// receiver find it without typing an IP — and pushes the outcome to the
// renderer. The transfer/crypto/discovery logic lives in the Node-pure core.

export interface LanController {
  /** Begin lending one or more accounts; resolves with the PIN + address to show. */
  lendStart(labels: string[]): Promise<{ pin: string; host: string; port: number; count: number }>;
  /** Cancel the active lend window (no-op if none). */
  lendStop(): { ok: boolean };
  /** Scan the LAN for PCs currently lending. */
  discover(): Promise<DiscoveredPeer[]>;
  /** Pull a bundle from a lending PC and register its accounts locally. */
  receive(host: string, port: number, pin: string): Promise<ApplyResult>;
}

export function createLan(ctx: AppContext): LanController {
  let session: LendSession | null = null;
  let responder: Responder | null = null;

  const clear = () => {
    session?.stop();
    responder?.stop();
    session = null;
    responder = null;
  };

  return {
    async lendStart(labels) {
      clear(); // replace any prior window
      const transfers = labels.map(serializeAccount); // may prompt macOS Keychain; may throw
      session = await startLendServer({
        transfers,
        onOutcome: (outcome, message) => {
          clear();
          ctx.send('lan-lend-status', { state: outcome, message });
        },
      });
      responder = startResponder({ port: session.port, count: transfers.length });
      return { pin: session.pin, host: session.host, port: session.port, count: transfers.length };
    },

    lendStop() {
      clear();
      return { ok: true };
    },

    discover() {
      return discover();
    },

    async receive(host, port, pin) {
      return receiveAccounts(host, port, pin);
    },
  };
}
