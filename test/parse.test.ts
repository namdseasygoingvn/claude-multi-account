import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanCapture, parseUsage, looksLoggedOut, TRUST_PROMPT_RE } from '../src/parse.js';

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

test('detects login/onboarding screens', () => {
  assert.ok(looksLoggedOut('Select login method\n1. Claude account with subscription'));
  assert.ok(looksLoggedOut('Choose the text style that looks best with your terminal'));
  assert.ok(looksLoggedOut('Paste code here if prompted:'));
  // repaints can drop spaces entirely once cursor-positioning is stripped
  assert.ok(looksLoggedOut('Choosethetextstylethatlooksbestwithyourterminal'));
  assert.ok(looksLoggedOut('Selectloginmethod'));
  assert.ok(!looksLoggedOut(fixture('usage-panel-sonnet.txt')));
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
