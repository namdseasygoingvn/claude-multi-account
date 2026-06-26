import test from 'node:test';
import assert from 'node:assert/strict';

import * as lc from '../src/lan-crypto.js';
import type { AccountTransfer } from '../src/lan-transfer.js';
import { startLendServer } from '../src/lan-server.js';
import { fetchAccounts } from '../src/lan-client.js';

const mkTransfer = (email: string): AccountTransfer => ({
  v: 1,
  email,
  token: JSON.stringify({ claudeAiOauth: { accessToken: `token-${email}` } }),
  oauthAccount: { emailAddress: email },
});

const TRANSFERS = [mkTransfer('a@example.com'), mkTransfer('b@example.com')];

// ── crypto primitives ─────────────────────────────────────────────────────────

test('both sides derive the same key from a fresh ECDH exchange + PIN', () => {
  const a = lc.createKeyPair();
  const b = lc.createKeyPair();
  const salt = lc.randomSalt();
  const pin = '1234';
  const keyA = lc.deriveKey(lc.sharedSecret(a.ecdh, b.publicKey), salt, pin);
  const keyB = lc.deriveKey(lc.sharedSecret(b.ecdh, a.publicKey), salt, pin);
  assert.deepEqual(keyA, keyB);
});

test('seal/open round-trips and a wrong PIN fails the auth tag', () => {
  const a = lc.createKeyPair();
  const b = lc.createKeyPair();
  const salt = lc.randomSalt();
  const secretA = lc.sharedSecret(a.ecdh, b.publicKey);
  const secretB = lc.sharedSecret(b.ecdh, a.publicKey);

  const sealed = lc.seal(lc.deriveKey(secretA, salt, '4321'), { hello: 'world' });
  assert.deepEqual(lc.open(lc.deriveKey(secretB, salt, '4321'), sealed), { hello: 'world' });
  assert.throws(() => lc.open(lc.deriveKey(secretB, salt, '0000'), sealed));
});

test('isValidPin only accepts 4 digits', () => {
  assert.ok(lc.isValidPin('0000'));
  assert.ok(!lc.isValidPin('12'));
  assert.ok(!lc.isValidPin('12ab'));
  assert.ok(!lc.isValidPin('12345'));
});

// ── server ↔ client transfer ──────────────────────────────────────────────────

test('a correct PIN transfers the whole bundle; the server then closes "done"', async () => {
  let outcome: string | null = null;
  const session = await startLendServer({
    transfers: TRANSFERS,
    onOutcome: (o) => {
      outcome = o;
    },
  });
  try {
    const got = await fetchAccounts('127.0.0.1', session.port, session.pin);
    assert.deepEqual(got, TRANSFERS);
    assert.equal(outcome, 'done');
  } finally {
    session.stop();
  }
});

test('a wrong PIN is rejected, and the third wrong try locks the window', async () => {
  let outcome: string | null = null;
  const session = await startLendServer({
    transfers: TRANSFERS,
    maxAttempts: 3,
    onOutcome: (o) => {
      outcome = o;
    },
  });
  const wrong = session.pin === '0000' ? '1111' : '0000';
  try {
    await assert.rejects(() => fetchAccounts('127.0.0.1', session.port, wrong), /wrong PIN/);
    await assert.rejects(() => fetchAccounts('127.0.0.1', session.port, wrong), /wrong PIN/);
    // third strike → server reports "locked"
    await assert.rejects(() => fetchAccounts('127.0.0.1', session.port, wrong), /too many/);
    assert.equal(outcome, 'failed');
    // window is closed now — a later attempt (even the right PIN) can't connect
    await assert.rejects(() => fetchAccounts('127.0.0.1', session.port, session.pin));
  } finally {
    session.stop();
  }
});
