import test from 'node:test';
import assert from 'node:assert/strict';
import { usageFromUnifiedHeaders, usageFromUsageEndpoint } from '../src/usage-api.js';

// A header getter backed by a plain object (case-sensitive here; real Headers
// is case-insensitive, but we always query the exact lowercase names).
const getter = (m: Record<string, string>) => (k: string) => (k in m ? m[k] : null);

test('maps unified rate-limit headers to session + weekly usage (real capture)', () => {
  const p = usageFromUnifiedHeaders(
    getter({
      'anthropic-ratelimit-unified-5h-utilization': '0.24',
      'anthropic-ratelimit-unified-5h-reset': '1782129600',
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-reset': '1782302400',
    }),
  );
  assert.ok(p);
  assert.equal(p.sessionPct, 24);
  assert.equal(p.weeklyAllPct, 5);
  assert.equal(p.confidence, 'high');
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[0].heading, 'Current session');
  assert.equal(p.sections[1].heading, 'Current week (all models)');
  assert.match(p.sessionResetAt ?? '', /\(.+\)/); // "<time> (<tz>)"
  assert.equal(p.weeklyModelPct, null); // per-model line isn't in headers
});

test('rounds utilization and clamps to 0–100', () => {
  const p = usageFromUnifiedHeaders(
    getter({
      'anthropic-ratelimit-unified-5h-utilization': '0.876',
      'anthropic-ratelimit-unified-7d-utilization': '1.5',
    }),
  );
  assert.ok(p);
  assert.equal(p.sessionPct, 88);
  assert.equal(p.weeklyAllPct, 100); // clamped, not 150
  assert.equal(p.confidence, 'high');
});

test('one window present → low confidence, one section', () => {
  const p = usageFromUnifiedHeaders(getter({ 'anthropic-ratelimit-unified-5h-utilization': '0.1' }));
  assert.ok(p);
  assert.equal(p.sessionPct, 10);
  assert.equal(p.weeklyAllPct, null);
  assert.equal(p.confidence, 'low');
  assert.equal(p.sections.length, 1);
});

test('returns null when no unified headers present (caller falls back)', () => {
  assert.equal(usageFromUnifiedHeaders(getter({})), null);
  assert.equal(usageFromUnifiedHeaders(getter({ 'x-other': '1' })), null);
});

// ── /api/oauth/usage JSON body (real capture shapes) ─────────────────────────

test('maps /api/oauth/usage with the per-model (Sonnet) weekly window', () => {
  // `utilization` here is already 0–100 (NOT a 0–1 fraction like the headers).
  const p = usageFromUsageEndpoint({
    five_hour: { utilization: 8, resets_at: '2026-06-22T16:59:59.370604+00:00' },
    seven_day: { utilization: 29, resets_at: '2026-06-23T11:59:59.370628+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 1, resets_at: '2026-06-23T12:00:00.370638+00:00' },
  });
  assert.ok(p);
  assert.equal(p.sessionPct, 8);
  assert.equal(p.weeklyAllPct, 29);
  assert.equal(p.weeklyModelLabel, 'Sonnet only');
  assert.equal(p.weeklyModelPct, 1);
  assert.equal(p.confidence, 'high');
  assert.equal(p.sections.length, 3);
  assert.equal(p.sections[0].heading, 'Current session');
  assert.equal(p.sections[1].heading, 'Current week (all models)');
  assert.equal(p.sections[2].heading, 'Current week (Sonnet only)');
  assert.match(p.sessionResetAt ?? '', /\(.+\)/); // "<time> (<tz>)"
  assert.match(p.weeklyAllResetAt ?? '', /\(.+\)/);
});

test('uses the Opus weekly window when the plan exposes it', () => {
  const p = usageFromUsageEndpoint({
    five_hour: { utilization: 10, resets_at: '2026-06-22T16:59:59Z' },
    seven_day: { utilization: 20, resets_at: '2026-06-23T11:59:59Z' },
    seven_day_opus: { utilization: 4, resets_at: '2026-06-23T12:00:00Z' },
    seven_day_sonnet: null,
  });
  assert.ok(p);
  assert.equal(p.weeklyModelLabel, 'Opus only');
  assert.equal(p.weeklyModelPct, 4);
  assert.equal(p.sections[2].heading, 'Current week (Opus only)');
});

test('rounds and clamps utilization; no per-model line → two sections', () => {
  const p = usageFromUsageEndpoint({
    five_hour: { utilization: 87.6 },
    seven_day: { utilization: 150 },
    seven_day_opus: null,
    seven_day_sonnet: null,
  });
  assert.ok(p);
  assert.equal(p.sessionPct, 88);
  assert.equal(p.weeklyAllPct, 100); // clamped, not 150
  assert.equal(p.weeklyModelLabel, null);
  assert.equal(p.weeklyModelPct, null);
  assert.equal(p.sections.length, 2);
});

test('one window present → low confidence, one section', () => {
  const p = usageFromUsageEndpoint({ five_hour: { utilization: 12 } });
  assert.ok(p);
  assert.equal(p.sessionPct, 12);
  assert.equal(p.weeklyAllPct, null);
  assert.equal(p.confidence, 'low');
  assert.equal(p.sections.length, 1);
});

test('returns null when no usage windows present (caller falls back to scrape)', () => {
  assert.equal(usageFromUsageEndpoint({}), null);
  assert.equal(usageFromUsageEndpoint({ seven_day_sonnet: { utilization: 5 } }), null);
});
