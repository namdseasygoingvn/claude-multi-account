import http from 'node:http';

import { applyAccounts, PROOF_MARKER, type AccountTransfer, type ApplyResult } from './lan-transfer.js';
import * as lc from './lan-crypto.js';

// The receiver side: dial a lending PC, prove knowledge of the PIN, pull the
// GCM-sealed account and (optionally) register it locally. Mirrors the protocol
// in lan-server.ts.

function httpJson(
  host: string,
  port: number,
  method: 'GET' | 'POST',
  reqPath: string,
  body?: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host,
        port,
        method,
        path: reqPath,
        timeout: 8000,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed: any = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* leave as {} */
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(httpError(parsed?.error));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out reaching the other PC')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpError(code: unknown): Error {
  if (code === 'bad-pin') return new Error('wrong PIN — check the code on the other PC');
  if (code === 'locked') return new Error('too many wrong tries — restart the lend on the other PC');
  if (code === 'pairing closed') return new Error('the lending window already closed');
  return new Error(typeof code === 'string' && code ? code : 'transfer failed');
}

/** Pull + decrypt the bundle from a lender (does not touch local accounts). */
export async function fetchAccounts(host: string, port: number, pin: string): Promise<AccountTransfer[]> {
  if (!lc.isValidPin(pin)) throw new Error('PIN must be 4 digits');
  const info = await httpJson(host, port, 'GET', '/info');
  if (typeof info?.aPub !== 'string' || typeof info?.salt !== 'string') {
    throw new Error('unexpected response — is that address running this app?');
  }
  const kp = lc.createKeyPair();
  const key = lc.deriveKey(lc.sharedSecret(kp.ecdh, info.aPub), info.salt, pin);
  const proof = lc.seal(key, { marker: PROOF_MARKER, ts: Date.now() });
  const res = await httpJson(host, port, 'POST', '/claim', { bPub: kp.publicKey, proof });
  if (!res?.payload) throw new Error('transfer failed');
  let bundle: AccountTransfer[];
  try {
    bundle = lc.open<AccountTransfer[]>(key, res.payload);
  } catch {
    throw new Error('could not decrypt the transfer (PIN mismatch)');
  }
  return Array.isArray(bundle) ? bundle : [bundle];
}

/** Pull a bundle and register its accounts locally (skipping ones already here). */
export async function receiveAccounts(host: string, port: number, pin: string): Promise<ApplyResult> {
  return applyAccounts(await fetchAccounts(host, port, pin));
}
