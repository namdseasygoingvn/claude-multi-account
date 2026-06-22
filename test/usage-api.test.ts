import test from 'node:test';
import assert from 'node:assert/strict';
import { usageFromUnifiedHeaders } from '../src/usage-api.js';

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
