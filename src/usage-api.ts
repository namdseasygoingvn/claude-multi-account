import { readSecret, serviceForConfigDir, sharedSlotService } from './keychain.js';
import type { ParsedUsage, UsageSection } from './types.js';

// Reading usage over HTTP instead of scraping the `/usage` REPL panel. Two
// strategies, picked by the orchestrator:
//
// 1. The usage endpoint directly (`fetchUsageFromEndpoint` → /api/oauth/usage).
//    This is the SAME endpoint the `/usage` panel reads, but a direct JSON call
//    skips the PTY spawn + TUI render that intermittently returns "no usage
//    sections" for an account that's active elsewhere (its REPL sits on
//    "Loading usage data…" and the settle logic gives up). It even carries the
//    per-model weekly window. Used for every account NOT held by VS Code.
//
// 2. The message endpoint's rate-limit headers (`fetchUsageViaApi` →
//    /v1/messages). The VS Code extension keeps the held account's usage
//    endpoint rate-limited, so for THAT account we read the same 5-hour/7-day
//    figures off the `anthropic-ratelimit-unified-*` headers a tiny message
//    call returns (still works while /usage is throttled; no per-model line).

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
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

// ── direct usage endpoint (/api/oauth/usage) ─────────────────────────────────

/** One usage window as the endpoint returns it: `utilization` is already 0–100. */
interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
/** The subset of the /api/oauth/usage body we read. */
interface UsageEndpointJson {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
}

/** Round a 0–100 utilization to an int percentage, clamped; null passes through. */
function pctOf(u: number | null | undefined): number | null {
  if (u == null || !Number.isFinite(u)) return null;
  return Math.max(0, Math.min(100, Math.round(u)));
}

/** ISO-8601 timestamp → the same short reset string fmtReset produces. */
function fmtResetIso(iso: string | null | undefined, withDate: boolean): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? fmtReset(ms / 1000, withDate) : null;
}

/**
 * Build ParsedUsage from the /api/oauth/usage JSON body — the SAME figures the
 * `/usage` panel renders, but straight from the endpoint (no PTY, no render
 * race). Unlike the unified headers this also carries the per-model weekly
 * window (Opus on Max plans, Sonnet on others). Returns null when neither the
 * 5-hour nor 7-day window is present, so the caller can fall back to the scrape.
 * Pure + side-effect free → unit-tested directly.
 */
export function usageFromUsageEndpoint(json: UsageEndpointJson): ParsedUsage | null {
  const five = json.five_hour ?? null;
  const seven = json.seven_day ?? null;
  const sessionPct = pctOf(five?.utilization);
  const weeklyAllPct = pctOf(seven?.utilization);
  if (sessionPct == null && weeklyAllPct == null) return null;

  // Per-model weekly: whichever of opus/sonnet the plan exposes (the other is null).
  const opus = json.seven_day_opus ?? null;
  const sonnet = json.seven_day_sonnet ?? null;
  const perModel = opus ? { label: 'Opus only', win: opus } : sonnet ? { label: 'Sonnet only', win: sonnet } : null;
  const weeklyModelPct = perModel ? pctOf(perModel.win.utilization) : null;
  const hasModel = perModel != null && weeklyModelPct != null;

  const sessionResetAt = fmtResetIso(five?.resets_at, false);
  const weeklyAllResetAt = fmtResetIso(seven?.resets_at, true);
  const weeklyModelResetAt = hasModel ? fmtResetIso(perModel!.win.resets_at, true) : null;

  const sections: UsageSection[] = [];
  if (sessionPct != null) sections.push({ heading: 'Current session', pct: sessionPct, resetsAt: sessionResetAt });
  if (weeklyAllPct != null)
    sections.push({ heading: 'Current week (all models)', pct: weeklyAllPct, resetsAt: weeklyAllResetAt });
  if (hasModel)
    sections.push({ heading: `Current week (${perModel!.label})`, pct: weeklyModelPct, resetsAt: weeklyModelResetAt });

  return {
    sessionPct,
    sessionResetAt,
    weeklyAllPct,
    weeklyAllResetAt,
    weeklyModelLabel: hasModel ? perModel!.label : null,
    weeklyModelPct: hasModel ? weeklyModelPct : null,
    weeklyModelResetAt,
    sections,
    confidence: sessionPct != null && weeklyAllPct != null ? 'high' : 'low',
  };
}

/**
 * GET the account's usage straight from /api/oauth/usage with its OAuth token.
 * Skips the REPL spawn + TUI render that intermittently yields "no usage
 * sections" for accounts active elsewhere. Returns null on any failure (network,
 * auth/expired token, non-2xx, unparseable body) so the caller can fall back to
 * the scrape — which also refreshes an expired token as a side effect.
 */
export async function fetchUsageFromEndpoint(token: string): Promise<ParsedUsage | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) {
      try {
        await res.arrayBuffer(); // drain so the socket is released
      } catch {
        /* ignore */
      }
      return null;
    }
    const json = (await res.json()) as UsageEndpointJson;
    return usageFromUsageEndpoint(json);
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
