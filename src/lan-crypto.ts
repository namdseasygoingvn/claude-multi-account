import crypto from 'node:crypto';

// Crypto primitives for the LAN account-lending handshake. Everything here is
// node:crypto only — no deps, identical on macOS and Windows.
//
// THREAT MODEL (deliberately scoped — see CLAUDE.md "lend over wifi"):
//   • The two PCs are the user's own, on the user's own LAN.
//   • A fresh ephemeral ECDH key agreement runs per transfer, so a PASSIVE
//     eavesdropper who records the whole exchange cannot recover the session
//     key (ECDH hardness) and so cannot brute-force the 4-digit PIN offline.
//   • The PIN is mixed into the KDF and the receiver must PROVE it knows the
//     PIN before the lender sends any credential (see lan-server.ts), so an
//     attacker gets only a few ONLINE guesses against 10 000 before lockout.
//   • An active on-path man-in-the-middle on the LAN could, within the short
//     pairing window, attempt the same online guesses — accepted as out of
//     scope for "lend to my own laptop at home" (a true PAKE would close this,
//     at the cost of a dependency). Bump PIN_DIGITS if that ever matters.

const CURVE = 'prime256v1'; // NIST P-256 — present in node:crypto on every platform
const ENC_ALGO = 'aes-256-gcm';
const PIN_DIGITS = 4;
const KDF_INFO_PREFIX = 'claude-lan-sync:v1:';

export interface KeyPair {
  /** Stateful ECDH holder; keep it to compute the shared secret later. */
  ecdh: crypto.ECDH;
  /** Base64 public key to hand to the peer. */
  publicKey: string;
}

export interface Sealed {
  iv: string;
  ct: string;
  tag: string;
}

/** Fresh ephemeral key agreement keypair for one transfer. */
export function createKeyPair(): KeyPair {
  const ecdh = crypto.createECDH(CURVE);
  const publicKey = ecdh.generateKeys('base64');
  return { ecdh, publicKey };
}

/** Compute the ECDH shared secret against the peer's base64 public key. */
export function sharedSecret(ecdh: crypto.ECDH, peerPublicKeyB64: string): Buffer {
  return ecdh.computeSecret(Buffer.from(peerPublicKeyB64, 'base64'));
}

/** A random base64 salt for the KDF (one per pairing session). */
export function randomSalt(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** A uniform, zero-padded PIN (e.g. "0427"). */
export function randomPin(): string {
  const max = 10 ** PIN_DIGITS;
  return crypto.randomInt(0, max).toString().padStart(PIN_DIGITS, '0');
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_DIGITS}}$`).test(pin);
}

/**
 * Derive the AES-256 session key from the ECDH secret, the session salt and the
 * PIN. The PIN lives in the HKDF `info`, so the same secret + a different PIN
 * yields a different key — a wrong PIN simply fails the GCM auth tag on open().
 */
export function deriveKey(secret: Buffer, saltB64: string, pin: string): Buffer {
  const salt = Buffer.from(saltB64, 'base64');
  const info = Buffer.from(KDF_INFO_PREFIX + pin);
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, 32));
}

/** AES-256-GCM encrypt a JSON-serialisable value. */
export function seal(key: Buffer, value: unknown): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypt + parse a sealed value. THROWS if the key is wrong or the data was
 * tampered with (GCM auth-tag failure) — callers treat that as "wrong PIN".
 */
export function open<T = unknown>(key: Buffer, sealed: Sealed): T {
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}
