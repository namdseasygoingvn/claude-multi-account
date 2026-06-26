import dgram from 'node:dgram';
import os from 'node:os';

// Zero-dependency LAN discovery so the receiver never types an IP. While a PC
// is lending it runs a tiny UDP responder; the receiver broadcasts a query and
// lists whoever answers. Discovery only reveals the address + a device name —
// the PIN still gates the actual credential transfer (see lan-server.ts), and
// the responder only runs while a lend window is open. Falls back to manual-IP
// entry when a network blocks broadcast (guest/AP-isolated wifi).

const DISCOVERY_PORT = 47600;
const QUERY = 'claude-lan-disco?v1';
const REPLY_PREFIX = 'claude-lan-disco!v1:'; // followed by JSON

export interface DiscoveredPeer {
  /** Lending machine's hostname, for display. */
  name: string;
  host: string;
  /** The lender's HTTP port to dial for the transfer. */
  port: number;
  /** How many accounts are on offer. */
  count: number;
}

export interface Responder {
  stop(): void;
}

/** While lending, answer discovery queries with this machine's lend address. */
export function startResponder(info: { port: number; count: number }): Responder {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const name = os.hostname();
  sock.on('message', (msg, rinfo) => {
    if (msg.toString() !== QUERY) return;
    const reply = Buffer.from(REPLY_PREFIX + JSON.stringify({ name, port: info.port, count: info.count }));
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', () => {
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  });
  sock.bind(DISCOVERY_PORT);
  return {
    stop: () => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Broadcast a discovery query and collect replies for ~timeoutMs. Each reply's
 * source address is the lender's IP (so the responder never sends its own).
 * Resolves to the de-duplicated peer list (empty if the network blocks broadcast).
 */
export function discover(timeoutMs = 1500): Promise<DiscoveredPeer[]> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const peers = new Map<string, DiscoveredPeer>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve([...peers.values()]);
    };

    sock.on('message', (msg, rinfo) => {
      const s = msg.toString();
      if (!s.startsWith(REPLY_PREFIX)) return;
      try {
        const info = JSON.parse(s.slice(REPLY_PREFIX.length));
        const port = Number(info.port);
        if (!port) return;
        peers.set(`${rinfo.address}:${port}`, {
          name: String(info.name ?? rinfo.address),
          host: rinfo.address,
          port,
          count: Number(info.count) || 0,
        });
      } catch {
        /* ignore malformed reply */
      }
    });
    sock.on('error', finish);
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
        sock.send(Buffer.from(QUERY), DISCOVERY_PORT, '255.255.255.255');
      } catch {
        finish();
        return;
      }
      setTimeout(finish, timeoutMs);
    });
  });
}
