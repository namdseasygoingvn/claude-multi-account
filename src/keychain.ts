import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where Claude Code keeps each account's OAuth token differs by OS:
//   • macOS  → a Keychain generic-password (service name is the handle).
//   • Windows/Linux → a `.credentials.json` FILE inside the config dir (the
//     file path is the handle).
// This module hides that behind one API: a "service" handle plus
// read/write/exists/copy over it. The default ~/.claude dir is the "shared
// slot" the VS Code extension + bare CLI read; any other config dir is an
// isolated per-account home.
const IS_MAC = process.platform === 'darwin';
const SHARED_SLOT_SERVICE = 'Claude Code-credentials';

/** Handle for the shared slot (what VS Code + the default `claude` use). */
export function sharedSlotService(): string {
  if (IS_MAC) return SHARED_SLOT_SERVICE;
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/** Handle Claude Code uses for a given config dir. */
export function serviceForConfigDir(configDir: string): string {
  const resolved = path.resolve(configDir);
  if (!IS_MAC) return path.join(resolved, '.credentials.json');
  // macOS: the default dir uses the bare service name; any other dir gets a
  // suffix derived from the dir's path hash.
  if (resolved === path.join(os.homedir(), '.claude')) return SHARED_SLOT_SERVICE;
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${SHARED_SLOT_SERVICE}-${hash}`;
}

// ── macOS: /usr/bin/security ─────────────────────────────────────────────────

/**
 * The `acct` attribute of an existing entry, read WITHOUT the secret (no
 * Keychain prompt). Lets a write target Claude's own item regardless of which
 * `acct` value it chose; returns null when the entry doesn't exist yet.
 */
function existingAccount(service: string): string | null {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = r.stdout.match(/"acct"<blob>="([^"]*)"/);
  return m ? m[1] : null;
}

/**
 * Read a generic-password secret via `security`. The FIRST time this app reads
 * an entry that Claude created, macOS shows a Keychain access dialog — the user
 * clicks "Always Allow" and subsequent reads are silent. Returns the secret
 * string (Claude stores a JSON blob), or null if the entry is missing/denied.
 */
function keychainRead(service: string): string | null {
  // Match by service name alone (it's unique per account), so reads don't
  // depend on which `acct` value Claude stored the item under.
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, ''); // security appends a trailing newline
}

/**
 * Create or UPDATE a generic-password secret. `-U` updates the existing item
 * in place (preserving its access-control list, so Claude keeps silent read
 * access to the shared slot). Returns true on success.
 *
 * NOTE: the secret is passed as an argv element; it's briefly visible to `ps`
 * for the same user. Acceptable for a local single-user tool managing the
 * user's own credentials; revisit with a native helper if that ever matters.
 */
function keychainWrite(service: string, secret: string): boolean {
  // Reuse the existing item's acct so `-U` updates it IN PLACE (preserving its
  // access list); for a brand-new item, default to the OS username — what
  // Claude Code itself uses — so Claude can still find it.
  const acct = existingAccount(service) ?? os.userInfo().username;
  const r = spawnSync(
    '/usr/bin/security',
    ['add-generic-password', '-U', '-s', service, '-a', acct, '-w', secret],
    { encoding: 'utf8' },
  );
  return r.status === 0;
}

function keychainExists(service: string): boolean {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service], { encoding: 'utf8' });
  return r.status === 0;
}

// ── Windows/Linux: a `.credentials.json` file ───────────────────────────────
// No OS prompt, no `acct`, no in-place update — the handle is just a path.

function fileRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // missing or unreadable
  }
}

function fileWrite(file: string, secret: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // mode 0o600 mirrors how Claude Code writes it (honoured on Linux; on
    // Windows the file inherits the user-profile ACL, which is already private).
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function fileExists(file: string): boolean {
  return fs.existsSync(file);
}

// ── public API: dispatch by platform ─────────────────────────────────────────

/** Read a credential by handle, or null if missing/denied. */
export function readSecret(service: string): string | null {
  return IS_MAC ? keychainRead(service) : fileRead(service);
}

/** Create or overwrite a credential. Returns true on success. */
export function writeSecret(service: string, secret: string): boolean {
  return IS_MAC ? keychainWrite(service, secret) : fileWrite(service, secret);
}

/** True if a credential with this handle exists (no secret read, no prompt). */
export function secretExists(service: string): boolean {
  return IS_MAC ? keychainExists(service) : fileExists(service);
}

/**
 * Copy a secret from one handle to another. Reads the source (may prompt once
 * for a Claude-created Keychain entry on macOS), writes the destination, then
 * verifies by reading it back. Throws on any failure so a caller never proceeds
 * on a half-completed copy. Platform-agnostic — it composes the helpers above.
 */
export function copySecret(fromService: string, toService: string): void {
  const secret = readSecret(fromService);
  if (secret == null) throw new Error(`credential not found or access denied: "${fromService}"`);
  if (!writeSecret(toService, secret)) throw new Error(`failed to write credential: "${toService}"`);
  const check = readSecret(toService);
  if (check !== secret) throw new Error(`credential copy verification failed for "${toService}"`);
}
