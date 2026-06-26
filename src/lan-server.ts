import http from 'node:http';
import os from 'node:os';

import { PROOF_MARKER, type AccountTransfer } from './lan-transfer.js';
import * as lc from './lan-crypto.js';

// The lender side: a short-lived HTTP server that hands one account to a peer
// that proves it knows the PIN. Protocol:
//   GET  /info  → { aPub, salt }              (key-agreement material; no secret)
//   POST /claim { bPub, proof } → { payload }  (credential only after a valid proof)
// A wrong proof costs one attempt; exhausting them — or the timeout — ends the
// session. The credential is only ever GCM-sealed to the PIN-derived key. See
// lan-crypto.ts for the (deliberately scoped) threat model.

const PROOF_FRESHNESS_MS = 60_000; // reject a replayed proof older than this
const DEFAULT_TIMEOUT_MS = 120_000; // pairing window auto-closes after 2 min
const DEFAULT_MAX_ATTEMPTS = 3; // wrong-PIN guesses before the window is killed
const MAX_BODY_BYTES = 64 * 1024;

export type LendOutcome = 'done' | 'failed' | 'expired';

export interface LendSession {
  /** 4-digit PIN to show on the lending PC. */
  pin: string;
  /** LAN address the receiver dials. */
  host: string;
  port: number;
  /** Close the window silently (no onOutcome) — e.g. the user cancelled. */
  stop(): void;
}

export interface LendOptions {
  transfer: AccountTransfer;
  /** Fired once when the session ends on its own (sent, locked out, or timed out). */
  onOutcome(outcome: LendOutcome, message: string): void;
  timeoutMs?: number;
  maxAttempts?: number;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Pick the LAN IPv4 to advertise. Prefers a private-range address (so a VPN's
 * public-looking address doesn't win) and falls back to loopback.
 */
function lanAddress(): string {
  const isPrivate = (ip: string) =>
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  let fallback: string | null = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (isPrivate(ni.address)) return ni.address;
      fallback ??= ni.address;
    }
  }
  return fallback ?? '127.0.0.1';
}

/** Start lending `transfer`. Resolves once listening, with the PIN + address. */
export function startLendServer(opts: LendOptions): Promise<LendSession> {
  const kp = lc.createKeyPair();
  const salt = lc.randomSalt();
  const pin = lc.randomPin();
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let attempts = 0;
  let ended = false;
  let timer: ReturnType<typeof setTimeout>;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => sendJson(res, 400, { error: String((e as Error)?.message ?? e) }));
  });

  const end = (outcome: LendOutcome | null, message: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    server.close();
    if (outcome) opts.onOutcome(outcome, message);
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (ended) return sendJson(res, 410, { error: 'pairing closed' });

    if (req.method === 'GET' && req.url === '/info') {
      return sendJson(res, 200, { aPub: kp.publicKey, salt });
    }

    if (req.method === 'POST' && req.url === '/claim') {
      const { bPub, proof } = JSON.parse(await readBody(req)) as { bPub?: string; proof?: lc.Sealed };
      if (typeof bPub !== 'string' || !proof) return sendJson(res, 400, { error: 'bad request' });

      const key = lc.deriveKey(lc.sharedSecret(kp.ecdh, bPub), salt, pin);
      let claim: { marker?: string; ts?: number } | null = null;
      try {
        claim = lc.open(key, proof);
      } catch {
        claim = null; // wrong PIN → GCM auth-tag failure
      }
      const valid =
        claim?.marker === PROOF_MARKER &&
        typeof claim.ts === 'number' &&
        Math.abs(Date.now() - claim.ts) < PROOF_FRESHNESS_MS;

      if (!valid) {
        attempts += 1;
        const locked = attempts >= maxAttempts;
        sendJson(res, 403, { error: locked ? 'locked' : 'bad-pin', triesLeft: Math.max(0, maxAttempts - attempts) });
        if (locked) end('failed', 'too many wrong PIN attempts — start over on the lending PC');
        return;
      }

      sendJson(res, 200, { payload: lc.seal(key, opts.transfer) });
      end('done', 'account sent');
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      timer = setTimeout(() => end('expired', 'pairing window expired'), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      resolve({ pin, host: lanAddress(), port, stop: () => end(null, '') });
    });
  });
}
