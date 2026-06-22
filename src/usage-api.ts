import { readSecret, sharedSlotService } from './keychain.js';
import type { ParsedUsage, UsageSection } from './types.js';

// Reading usage WITHOUT the throttled /api/oauth/usage endpoint.
//
// `/usage` (what we scrape from the REPL) hits a dedicated per-account usage
// endpoint that the VS Code extension keeps rate-limited while it's signed into
// that account. But the account's NORMAL message endpoint still works (that's
// why it stays usable in VS Code), and every /v1/messages response carries
// `anthropic-ratelimit-unified-*` headers that encode the same 5-hour (session)
// and 7-day (weekly) usage. So a tiny message call lets us read usage for an
// account even while its /usage endpoint is throttled.

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // cheapest; max_tokens:1 → a few tokens per check
const SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."; // required for claude.ai OAuth tokens
const OAUTH_BETA = 'oauth-2025-04-20';
const TIMEOUT_MS = 8_000;

/** Pull the OAuth access token out of a keychain credentials blob. */
function tokenFromSecret(secret: string): string | null {
  try {
    const d = JSON.parse(secret) as Record<string, unknown>;
    const o = (d.claudeAiOauth ?? d) as Record<string, unknown>;
    return typeof o.accessToken === 'string' ? o.accessToken : null;
  } catch {
    return null;
  }
}

/** Format a unix-epoch-seconds reset into a short local string like the panel's. */
function fmtReset(epochSec: number | null, withDate: boolean): string | null {
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

/**
 * Build ParsedUsage from the unified rate-limit headers Anthropic returns on a
 * /v1/messages response. `get` is a header lookup (case-insensitive via Headers).
 * Returns null when neither window header is present, so the caller can fall back.
 * Pure + side-effect free → unit-tested directly.
 */
export function usageFromUnifiedHeaders(get: (k: string) => string | null): ParsedUsage | null {
  const num = (k: string): number | null => {
    const v = get(k);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const fiveH = num('anthropic-ratelimit-unified-5h-utilization');
  const sevenD = num('anthropic-ratelimit-unified-7d-utilization');
  if (fiveH == null && sevenD == null) return null;
  const pct = (u: number | null): number | null =>
    u == null ? null : Math.max(0, Math.min(100, Math.round(u * 100)));
  const sessionPct = pct(fiveH);
  const weeklyAllPct = pct(sevenD);
  const sessionResetAt = fmtReset(num('anthropic-ratelimit-unified-5h-reset'), false);
  const weeklyAllResetAt = fmtReset(num('anthropic-ratelimit-unified-7d-reset'), true);
  const sections: UsageSection[] = [];
  if (sessionPct != null) sections.push({ heading: 'Current session', pct: sessionPct, resetsAt: sessionResetAt });
  if (weeklyAllPct != null)
    sections.push({ heading: 'Current week (all models)', pct: weeklyAllPct, resetsAt: weeklyAllResetAt });
  return {
    sessionPct,
    sessionResetAt,
    weeklyAllPct,
    weeklyAllResetAt,
    weeklyModelLabel: null, // not exposed in headers — only the /usage scrape has the per-model line
    weeklyModelPct: null,
    weeklyModelResetAt: null,
    sections,
    confidence: sessionPct != null && weeklyAllPct != null ? 'high' : 'low',
  };
}

/**
 * Make a minimal /v1/messages call with the given OAuth token and read the
 * unified rate-limit headers. Works even when /usage is rate-limited. Costs a
 * few haiku tokens. Returns null on any failure (network, auth, missing headers).
 */
export async function fetchUsageViaApi(token: string): Promise<ParsedUsage | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MESSAGES_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1,
        system: SYSTEM,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // Headers carry the usage even on a 429 (account at its limit), so parse
    // regardless of status; only the headers' presence matters.
    const parsed = usageFromUnifiedHeaders((k) => res.headers.get(k));
    try {
      await res.arrayBuffer(); // drain so the socket is released
    } catch {
      /* ignore */
    }
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch usage for the account currently in the shared slot — i.e. the one the
 * VS Code extension holds. Its token is kept fresh by the extension, so no
 * refresh is needed. Returns null if the slot can't be read or the call fails.
 */
export async function fetchActiveAccountUsage(): Promise<ParsedUsage | null> {
  const secret = readSecret(sharedSlotService());
  if (!secret) return null;
  const token = tokenFromSecret(secret);
  return token ? fetchUsageViaApi(token) : null;
}
