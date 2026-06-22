import { getAccount, loadRegistry, probeLogin } from './registry.js';
import { checkUsage } from './usage.js';
import { fetchActiveAccountUsage, fetchUsageForConfigDir } from './usage-api.js';
import { getActiveVSCodeLabel, isVSCodeRunning } from './switcher.js';
import type { AccountConfig, ParsedUsage, UsageResult } from './types.js';
import type { AppContext } from './context.js';

/**
 * Cap on concurrent /usage checks. Each check spawns a full `claude` REPL and
 * hits the per-account usage endpoint, so a wide parallel fan-out (every account
 * at once, on launch) both spikes CPU and helps trip the endpoint's rate limit.
 * A small pool smooths the burst; the monitor isn't latency-critical.
 */
const USAGE_CHECK_CONCURRENCY = 2;

/** Map over items with a bounded worker pool, preserving input order in the output. */
async function mapPooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The email VS Code's extension currently holds, or null. While VS Code is
 * running and signed into an account, the extension continuously polls THAT
 * account's usage endpoint, so the monitor's /usage for the same account is
 * rate-limited no matter how long we wait. Keyed by email (not label) because
 * the same account can be registered under several labels/config dirs.
 */
function vsCodeHeldEmail(): string | null {
  const label = getActiveVSCodeLabel();
  if (!label || !isVSCodeRunning()) return null;
  const acc = getAccount(label);
  return acc ? probeLogin(acc).email : null;
}

/** A synthesized "can't read this live" result for an account VS Code holds. */
function heldByVSCodeResult(ctx: AppContext, acc: AccountConfig): UsageResult {
  const prior = ctx.lastResults.get(acc.label);
  return {
    label: acc.label,
    checkedAt: new Date().toISOString(),
    ok: false,
    loggedIn: true,
    rateLimited: false,
    heldByVSCode: true,
    parsed: prior?.parsed ?? null, // keep the last-known bars if we have them
    raw: '',
    error:
      "active in VS Code — couldn't read live usage just now. Its extension uses this account's usage endpoint; try again or switch VS Code to another account.",
    durationMs: 0,
  };
}

/**
 * Usage for the account VS Code holds. Its /usage endpoint is rate-limited by
 * the extension, but the message endpoint isn't — so read usage from the
 * unified rate-limit headers on a tiny API call (session + weekly; the
 * per-model weekly line isn't in headers). Falls back to a calm note if the API
 * path is unavailable. Same single result fans out to every label sharing it.
 */
async function heldGroupResults(ctx: AppContext, group: AccountConfig[]): Promise<UsageResult[]> {
  let parsed: ParsedUsage | null = null;
  try {
    parsed = await fetchActiveAccountUsage();
  } catch {
    parsed = null;
  }
  if (parsed && parsed.sections.length > 0) {
    const p = parsed;
    const now = new Date().toISOString();
    return group.map((acc) => ({
      label: acc.label,
      checkedAt: now,
      ok: true,
      loggedIn: true,
      rateLimited: false,
      parsed: p,
      raw: '',
      error: null,
      durationMs: 0,
    }));
  }
  return group.map((acc) => heldByVSCodeResult(ctx, acc));
}

/**
 * Usage for one non-held account group. Tries the account's usage endpoint
 * directly first (fast JSON, no PTY) — that alone fixes the intermittent "no
 * usage sections" the REPL scrape hits for an account active elsewhere, whose
 * panel sits on "Loading usage data…" until the settle logic gives up. Falls
 * back to the real /usage scrape when the direct read is unavailable (logged
 * out, expired/missing token, network) — the scrape also refreshes the token,
 * so the next cycle's direct read succeeds.
 */
async function readLiveGroup(ctx: AppContext, group: AccountConfig[]): Promise<UsageResult[]> {
  const status = (phase: string): void => {
    for (const acc of group) ctx.send('usage-status', { label: acc.label, phase });
  };
  status('reading usage');
  let direct: ParsedUsage | null = null;
  try {
    direct = await fetchUsageForConfigDir(group[0].configDir);
  } catch {
    direct = null;
  }
  if (direct && direct.sections.length > 0) {
    const parsed = direct;
    const now = new Date().toISOString();
    return group.map((acc) => ({
      label: acc.label,
      checkedAt: now,
      ok: true,
      loggedIn: true,
      rateLimited: false,
      parsed,
      raw: '',
      error: null,
      durationMs: 0,
    }));
  }
  // mirror progress to every label sharing this account so all cards animate
  const run = await checkUsage(group[0], { onPhase: status });
  // One real check, applied under each label that resolves to this account.
  return group.map((acc) => ({ ...run, label: acc.label }));
}

/**
 * Fan out /usage over the given labels (or all). The same Anthropic account can
 * be registered under multiple labels/config dirs (e.g. ~/.claude plus an
 * accounts/<x> copy of the same login); they share ONE per-account usage
 * endpoint, so checking each separately doubles the load and helps trip its rate
 * limit. Group by signed-in email, check one representative per account through
 * a bounded pool, then fan the single result out to every label that shares it.
 * Accounts with no detectable email (logged out) can't be grouped, so each is
 * its own group and still gets attempted (to report "not logged in").
 */
export async function runUsageCheck(ctx: AppContext, labels?: string[]): Promise<UsageResult[]> {
  const all = loadRegistry();
  const requested = labels && labels.length > 0 ? all.filter((a) => labels.includes(a.label)) : all;
  const targets = requested.filter((a) => !ctx.checking.has(a.label));
  if (targets.length === 0) return [];
  const labelsRun = targets.map((t) => t.label);
  for (const l of labelsRun) ctx.checking.add(l);
  ctx.send('check-start', { labels: labelsRun });

  const groups = new Map<string, AccountConfig[]>();
  for (const acc of targets) {
    const email = probeLogin(acc).email;
    const key = email ?? `nogroup:${acc.label}`; // logged-out accounts never merge
    const group = groups.get(key);
    if (group) group.push(acc);
    else groups.set(key, [acc]);
  }

  const heldEmail = vsCodeHeldEmail();
  const apply = (results: UsageResult[]): void => {
    for (const result of results) {
      ctx.lastResults.set(result.label, result);
      ctx.send('usage-result', { result });
    }
    ctx.updateBadge();
  };

  try {
    // VS Code is polling the held account's /usage endpoint, so scraping /usage
    // for it is futile — read it from the message endpoint's rate-limit headers
    // instead (heldGroupResults). Everyone else goes through the normal scrape.
    const heldGroups: AccountConfig[][] = [];
    const liveGroups: AccountConfig[][] = [];
    for (const [key, group] of groups) {
      (heldEmail && key === heldEmail ? heldGroups : liveGroups).push(group);
    }

    const livePromise = mapPooled(liveGroups, USAGE_CHECK_CONCURRENCY, async (group) => {
      const results = await readLiveGroup(ctx, group);
      apply(results);
      return results;
    });

    const heldPromise = Promise.all(
      heldGroups.map(async (group) => {
        for (const acc of group) ctx.send('usage-status', { label: acc.label, phase: 'reading usage via API' });
        const results = await heldGroupResults(ctx, group);
        apply(results);
        return results;
      }),
    );

    const [live, held] = await Promise.all([livePromise, heldPromise]);
    return [...live.flat(), ...held.flat()];
  } finally {
    for (const l of labelsRun) ctx.checking.delete(l);
    ctx.send('check-done', { labels: labelsRun });
  }
}
