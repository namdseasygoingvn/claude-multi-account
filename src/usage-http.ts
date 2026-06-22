// Shared bits for the two "usage over HTTP" strategies (usage-api's rate-limit
// header path and usage-endpoint's direct /api/oauth/usage path). Leaf module:
// no project imports beyond it, so neither strategy file has to depend on the
// other (keeps the import graph acyclic).

export const TIMEOUT_MS = 8_000;
export const OAUTH_BETA = 'oauth-2025-04-20';

/** Format a unix-epoch-seconds reset into a short local string like the panel's. */
export function fmtReset(epochSec: number | null, withDate: boolean): string | null {
  if (!epochSec) return null;
  const d = new Date(epochSec * 1000);
  let tz = 'local';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    /* keep 'local' */
  }
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, '')
    .toLowerCase();
  if (!withDate) return `${time} (${tz})`;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${date} at ${time} (${tz})`;
}
