import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Claude Code stores each account's OAuth token as a macOS Keychain
// generic-password. The default ~/.claude dir uses the bare service name; any
// other config dir gets a suffix derived from the dir's path hash.
const SHARED_SLOT_SERVICE = 'Claude Code-credentials';

export function sharedSlotService(): string {
  return SHARED_SLOT_SERVICE;
}

/** The keychain service name Claude Code uses for a given config dir. */
export function serviceForConfigDir(configDir: string): string {
  const resolved = path.resolve(configDir);
  if (resolved === path.join(os.homedir(), '.claude')) return SHARED_SLOT_SERVICE;
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${SHARED_SLOT_SERVICE}-${hash}`;
}

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
 * Uses spawnSync with an args array (no shell) so paths/secrets are never
 * interpreted by a shell.
 */
export function readSecret(service: string): string | null {
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
export function writeSecret(service: string, secret: string): boolean {
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

/** True if a generic-password entry with this service exists (no secret read, no prompt). */
export function secretExists(service: string): boolean {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * Copy a secret from one service to another. Reads the source (may prompt once
 * for a Claude-created entry), writes the destination, then verifies by reading
 * the destination back (silent — this app created it). Throws on any failure so
 * a caller never proceeds on a half-completed copy.
 */
export function copySecret(fromService: string, toService: string): void {
  const secret = readSecret(fromService);
  if (secret == null) throw new Error(`keychain entry not found or access denied: "${fromService}"`);
  if (!writeSecret(toService, secret)) throw new Error(`failed to write keychain entry: "${toService}"`);
  const check = readSecret(toService);
  if (check !== secret) throw new Error(`keychain copy verification failed for "${toService}"`);
}
