import { readSecret, serviceForConfigDir, sharedSlotService } from './keychain.js';
import { fmtReset, OAUTH_BETA, TIMEOUT_MS } from './usage-http.js';
import { fetchUsageFromEndpoint, usageFromUsageEndpoint } from './usage-endpoint.js';
import type { ParsedUsage, UsageSection } from './types.js';

// Reading usage over HTTP instead of scraping the `/usage` REPL panel. Two
// strategies, picked by the orchestrator:
//
// 1. The usage endpoint directly (`fetchUsageFromEndpoint` → /api/oauth/usage,
//    in usage-endpoint.ts). Used for every account NOT held by VS Code.
//
// 2. The message endpoint's rate-limit headers (`fetchUsageViaApi` →
//    /v1/messages). The VS Code extension keeps the held account's usage
//    endpoint rate-limited, so for THAT account we read the same 5-hour/7-day
//    figures off the `anthropic-ratelimit-unified-*` headers a tiny message
//    call returns (still works while /usage is throttled; no per-model line).

// Re-exported so the usage-api unit tests (and any caller) see one usage-API
// surface regardless of which file implements each strategy.
export { usageFromUsageEndpoint } from './usage-endpoint.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // cheapest; max_tokens:1 → a few tokens per check
const SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."; // required for claude.ai OAuth tokens

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
 * Usage for a specific account (by its config dir), read from /api/oauth/usage
 * with that account's own stored OAuth token. Returns null when the account has
 * no readable token (logged out) or the call fails — the caller then scrapes.
 */
export async function fetchUsageForConfigDir(configDir: string): Promise<ParsedUsage | null> {
  const secret = readSecret(serviceForConfigDir(configDir));
  if (!secret) return null;
  const token = tokenFromSecret(secret);
  return token ? fetchUsageFromEndpoint(token) : null;
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
