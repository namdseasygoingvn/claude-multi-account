import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanCapture,
  parseUsage,
  looksLoggedOut,
  looksRateLimited,
  TRUST_PROMPT_RE,
  THEME_PROMPT_RE,
  CONTINUE_PROMPT_RE,
} from '../src/parse.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), 'utf8');

test('parses a real captured /usage panel (claude 2.1.173, Sonnet-only weekly line)', () => {
  const parsed = parseUsage(fixture('usage-panel-sonnet.txt'));
  assert.equal(parsed.sessionPct, 18);
  assert.equal(parsed.sessionResetAt, '1:29am (Asia/Saigon)');
  assert.equal(parsed.weeklyAllPct, 30);
  assert.equal(parsed.weeklyAllResetAt, 'Jun 13 at 6pm (Asia/Saigon)');
  assert.equal(parsed.weeklyModelLabel, 'Sonnet only');
  assert.equal(parsed.weeklyModelPct, 1);
  assert.equal(parsed.weeklyModelResetAt, 'Jun 13 at 5:59pm (Asia/Saigon)');
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.sections.length, 3);
  // the "88% of your usage came from…" insight lines must not become sections
  assert.ok(parsed.sections.every((s) => /^Current /.test(s.heading)));
});

test('parses an Opus-flavored panel with spaced percentages', () => {
  const text = [
    'Current session',
    ' 42 % used',
    'Resets 3pm (America/New_York)',
    '',
    'Current week (all models)',
    '7% used',
    'Resets Oct 14 at 10:59am (America/New_York)',
    '',
    'Current week (Opus)',
    '99% used',
    'Resets Oct 14 at 10:59am (America/New_York)',
  ].join('\n');
  const parsed = parseUsage(text);
  assert.equal(parsed.sessionPct, 42);
  assert.equal(parsed.weeklyAllPct, 7);
  assert.equal(parsed.weeklyModelLabel, 'Opus');
  assert.equal(parsed.weeklyModelPct, 99);
  assert.equal(parsed.confidence, 'high');
});

test('later frames win over earlier partial frames', () => {
  const text = [
    'Current session',
    '10%used',
    'Resets 1pm (UTC)',
    '— repaint —',
    'Current session',
    '55%used',
    'Resets 2pm (UTC)',
  ].join('\n');
  const parsed = parseUsage(text);
  assert.equal(parsed.sessionPct, 55);
  assert.equal(parsed.sessionResetAt, '2pm (UTC)');
});

test('missing weekly section lowers confidence but still returns sections', () => {
  const text = ['Current session', '12% used', 'Resets 9am (UTC)'].join('\n');
  const parsed = parseUsage(text);
  assert.equal(parsed.sessionPct, 12);
  assert.equal(parsed.weeklyAllPct, null);
  assert.equal(parsed.confidence, 'low');
  assert.equal(parsed.sections.length, 1);
});

test('empty capture parses to zero sections, low confidence', () => {
  const parsed = parseUsage('');
  assert.equal(parsed.sections.length, 0);
  assert.equal(parsed.confidence, 'low');
});

test('cleanCapture strips ANSI, box drawing, progress bars and collapses blanks', () => {
  const raw =
    '\u001b[2J\u001b[1;1H╭──────────╮\r\n│ \u001b[1mCurrent session\u001b[0m │\r\n│ ███░░░░ 18%used │\r\n\r\n\r\n╰──────────╯';
  const clean = cleanCapture(raw);
  assert.ok(clean.includes('Current session'));
  assert.ok(clean.includes('18%used'));
  assert.ok(!/[╭╰│█░]/.test(clean));
  assert.ok(!clean.includes('\u001b'));
  assert.ok(!clean.includes('\n\n\n'));
});

test('cleanCapture + parseUsage work together on a synthetic PTY stream', () => {
  const raw =
    'Welcome!\r\n\u001b[36m? for shortcuts\u001b[0m\r\n' +
    '\u001b[1mCurrent session\u001b[0m\r\n▮▮▮▮▯▯▯▯ \u001b[33m25%used\u001b[0m\r\nResets 6pm (UTC)\r\n' +
    'Current week (all models)\r\n▮▮▯▯▯▯▯▯ 3%used\r\nResets Jun 20 at 9am (UTC)\r\n';
  const parsed = parseUsage(cleanCapture(raw));
  assert.equal(parsed.sessionPct, 25);
  assert.equal(parsed.weeklyAllPct, 3);
  assert.equal(parsed.confidence, 'high');
});

test('parses the spaceless TUI rendering (regression: weekly section was dropped)', () => {
  // Real namds666@gmail.com capture: the panel rendered with cursor positioning
  // instead of spaces, so headings/resets arrived as "Currentweek(allmodels)" /
  // "ResetsJun20at4:59pm". The session parsed but the weekly section was lost.
  const clean = [
    'Currentsession',
    '4%used',
    'Resets7:39am(Asia/Saigon)',
    'Currentweek(allmodels)',
    '7%used',
    'ResetsJun20at4:59pm(Asia/Saigon)',
  ].join('\n');
  const parsed = parseUsage(clean);
  assert.equal(parsed.sessionPct, 4);
  assert.equal(parsed.weeklyAllPct, 7);
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.sessionResetAt, '7:39am (Asia/Saigon)');
  assert.equal(parsed.weeklyAllResetAt, 'Jun20at4:59pm (Asia/Saigon)');
  assert.equal(parsed.sections.length, 2);
  assert.ok(parsed.sections.every((s) => /^Current /.test(s.heading)));
});

test('parses the 2.1.185 inline layout (regression: pct/reset collapsed onto the heading line)', () => {
  // claude 2.1.185 redesigned the panel so the percentage and reset render on
  // the SAME line as the heading, preceded by a progress-ring glyph that
  // survives ANSI stripping ("Current session ◯ 35%used Resets 12am …"). The
  // old end-anchored, line-by-line heading match found zero sections here and
  // the app reported "no usage sections found in the /usage panel".
  const clean = [
    'Current session ◯ 35%used Resets 12am (Asia/Saigon)',
    'Current week (all models) ◯ 34%used Resets Jun 27, 6pm (Asia/Saigon)',
    'Current week (Sonnet only) ◯ 1%used Resets Jun 27, 6pm (Asia/Saigon)',
    "What's contributing to your limits usage?",
    'Scanning local sessions…',
    '88% of your usage came from subagent-heavy sessions',
  ].join('\n');
  const parsed = parseUsage(clean);
  assert.equal(parsed.sessionPct, 35);
  assert.equal(parsed.sessionResetAt, '12am (Asia/Saigon)');
  assert.equal(parsed.weeklyAllPct, 34);
  assert.equal(parsed.weeklyAllResetAt, 'Jun 27, 6pm (Asia/Saigon)');
  assert.equal(parsed.weeklyModelLabel, 'Sonnet only');
  assert.equal(parsed.weeklyModelPct, 1);
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.sections.length, 3);
  // the "88% of your usage…" insight line must not leak into the last section
  assert.ok(parsed.sections.every((s) => /^Current /.test(s.heading)));
});

test('detects genuine logged-out screens', () => {
  assert.ok(looksLoggedOut('Select login method\n1. Claude account with subscription'));
  assert.ok(looksLoggedOut('Paste code here if prompted:'));
  // repaints can drop spaces entirely once cursor-positioning is stripped
  assert.ok(looksLoggedOut('Selectloginmethod'));
  assert.ok(!looksLoggedOut(fixture('usage-panel-sonnet.txt')));
});

test('detects the /usage rate-limit error panel', () => {
  assert.ok(looksRateLimited('Error: Usage endpoint is rate limited. Please try again in a moment.'));
  // whitespace-insensitive: TUI repaints can drop the spaces between words
  assert.ok(looksRateLimited('UsageendpointisratelimitedPleasetryagaininamoment'));
  // a normal usage panel (or a logged-out screen) must not trip it
  assert.ok(!looksRateLimited(fixture('usage-panel-sonnet.txt')));
  assert.ok(!looksRateLimited('Current session\n18% used\nResets 1am (UTC)'));
});

test('the theme picker is NOT treated as logged out', () => {
  // A signed-in but un-onboarded config dir reopens at the theme picker. That
  // is an onboarding screen to click through, not proof of being logged out —
  // keying off it produced false "not logged in" results.
  assert.ok(!looksLoggedOut('Choose the text style that looks best with your terminal'));
  assert.ok(!looksLoggedOut('Choosethetextstylethatlooksbestwithyourterminal'));
  // …but it IS recognized as an onboarding screen the flows answer with Enter.
  assert.ok(THEME_PROMPT_RE.test('Choose the text style that looks best with your terminal'));
  assert.ok(THEME_PROMPT_RE.test('Choosethetextstylethatlooksbestwithyourterminal'));
});

test('detects the "press Enter to continue" interstitial', () => {
  assert.ok(CONTINUE_PROMPT_RE.test('Press Enter to continue'));
  assert.ok(CONTINUE_PROMPT_RE.test('PressEntertocontinue'));
});

test('detects the folder-trust dialog across claude versions', () => {
  // older wording
  assert.ok(TRUST_PROMPT_RE.test('Do you trust the files in this folder?'));
  // claude 2.1.x wording, with and without spaces (as captured from a real PTY)
  assert.ok(TRUST_PROMPT_RE.test('Quick safety check: Is this a project you created or one you trust?'));
  assert.ok(TRUST_PROMPT_RE.test('Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?'));
  assert.ok(TRUST_PROMPT_RE.test('❯1.Yes,Itrustthisfolder'));
  assert.ok(!TRUST_PROMPT_RE.test(fixture('usage-panel-sonnet.txt')));
});
