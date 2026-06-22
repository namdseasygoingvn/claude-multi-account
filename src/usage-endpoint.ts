// ── Direct usage endpoint (/api/oauth/usage) ──────────────────────────────────
// The SAME endpoint the `/usage` panel reads, but a direct JSON call skips the
// PTY spawn + TUI render that intermittently returns "no usage sections" for an
// account active elsewhere. It also carries the per-model weekly window (Opus on
// Max plans, Sonnet on others). Used for every account NOT held by VS Code.
import { fmtReset, OAUTH_BETA, TIMEOUT_MS } from './usage-http.js';
import type { ParsedUsage, UsageSection } from './types.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

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
