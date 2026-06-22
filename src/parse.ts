import stripAnsi from 'strip-ansi';
import type { ParsedUsage, UsageSection } from './types.js';

/**
 * Normalize a raw PTY capture into plain text lines: strip ANSI escapes,
 * normalize newlines, blank out TUI chrome (box drawing, progress-bar blocks,
 * spinner glyphs), collapse whitespace.
 */
export function cleanCapture(raw: string): string {
  let s = stripAnsi(raw);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s.split('\n').map((line) =>
    line
      // box drawing, block elements (progress bars), geometric shapes, braille spinners
      .replace(/[─-▟■-◿⠀-⣿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && out[out.length - 1] === '') continue; // collapse blank runs
    out.push(line);
  }
  return out.join('\n').trim();
}

// Headings, percentages and reset lines can all render spaceless once the TUI's
// cursor-positioning escapes are stripped ("Currentweek(allmodels)",
// "ResetsJun20at4:59pm") — so every pattern tolerates missing whitespace and
// headings are canonicalized (space-stripped) before lookup.
//
// HEADING_RE is deliberately NOT end-anchored and is matched globally across the
// whole capture rather than line-by-line. Older claude builds rendered each
// section as three lines (heading, "18%used", "Resets …"); 2.1.185 collapses the
// percentage (and a leading progress-ring glyph that survives ANSI stripping)
// onto the heading line — "Current session 35%used Resets 12am". Anchoring the
// heading to end-of-line dropped every section there. Instead we find each
// heading wherever it appears and scan the text up to the next heading for the
// percentage and reset, so both layouts parse identically.
const HEADING_RE = /Current\s*(session|week|month)\b(?:\s*\(([^)]*)\))?/gi;
const PCT_RE = /(\d{1,3})\s*%\s*used/i;
const RESET_RE = /Resets\s*([^\n]+)/i;

/** Multi-word weekly qualifiers, keyed by their space-stripped lowercased form. */
const QUAL_PRETTY: Record<string, string> = {
  allmodels: 'all models',
  opusonly: 'Opus only',
  sonnetonly: 'Sonnet only',
  haikuonly: 'Haiku only',
};

interface Heading {
  period: string; // "session" | "week" | "month"
  qualKey: string; // space-stripped lowercased qualifier ("allmodels", "opus", "")
  display: string; // e.g. "Current week (all models)"
}

/** Build a Heading from a regex match of HEADING_RE (capture groups: period, qualifier). */
function toHeading(period: string, rawQualifier: string): Heading {
  const p = period.toLowerCase();
  const rawQual = rawQualifier.trim();
  const qualKey = rawQual.replace(/\s+/g, '').toLowerCase();
  const pretty = qualKey ? (QUAL_PRETTY[qualKey] ?? rawQual.replace(/\s+/g, ' ')) : '';
  return { period: p, qualKey, display: `Current ${p}${pretty ? ` (${pretty})` : ''}` };
}

/** Canonical, whitespace-independent key for a heading. */
function headingKey(h: Heading): string {
  return h.qualKey ? `${h.period} (${h.qualKey})` : h.period;
}

/** Tidy a captured reset string: ensure a single space before the timezone paren. */
function normalizeReset(s: string): string {
  return s.replace(/\s*\(/, ' (').trim();
}

/**
 * Parse the rendered /usage panel out of a cleaned capture.
 *
 * The capture usually contains several redraw frames of the same panel
 * (spinner, partial paints, final paint), so for each distinct heading the
 * LAST occurrence wins — that is the fully rendered frame.
 */
export function parseUsage(clean: string): ParsedUsage {
  const byKey = new Map<string, UsageSection>(); // canonical key -> section; insertion order = render order
  // Locate every heading first; each section's data is the text between its
  // heading and the next one — robust to whether pct/reset sit on the heading
  // line (2.1.185) or on the lines below it (older builds).
  const heads: Array<{ h: Heading; from: number; until: number }> = [];
  HEADING_RE.lastIndex = 0;
  for (let m = HEADING_RE.exec(clean); m; m = HEADING_RE.exec(clean)) {
    heads.push({ h: toHeading(m[1], m[2] ?? ''), from: HEADING_RE.lastIndex, until: clean.length });
    if (heads.length > 1) heads[heads.length - 2].until = m.index; // close the previous segment here
  }
  for (const { h, from, until } of heads) {
    const segment = clean.slice(from, until);
    const pm = segment.match(PCT_RE);
    const rm = segment.match(RESET_RE);
    const pct = pm ? Math.min(100, parseInt(pm[1], 10)) : null;
    const resetsAt = rm ? normalizeReset(rm[1]) : null;
    if (pct === null && resetsAt === null) continue; // heading echoed without data (e.g. autocomplete)
    const key = headingKey(h);
    byKey.delete(key); // re-insert so a later, more complete frame wins and refreshes order
    byKey.set(key, { heading: h.display, pct, resetsAt });
  }

  const sections = [...byKey.values()];
  const session = byKey.get('session') ?? null;
  const weeklyAll = byKey.get('week (allmodels)') ?? null;
  let weeklyModel: UsageSection | null = null;
  let weeklyModelLabel: string | null = null;
  for (const [key, sec] of byKey) {
    if (key.startsWith('week (') && key !== 'week (allmodels)') {
      weeklyModel = sec;
      weeklyModelLabel = sec.heading.match(/\((.+)\)/)?.[1] ?? null;
    }
  }

  return {
    sessionPct: session?.pct ?? null,
    sessionResetAt: session?.resetsAt ?? null,
    weeklyAllPct: weeklyAll?.pct ?? null,
    weeklyAllResetAt: weeklyAll?.resetsAt ?? null,
    weeklyModelLabel,
    weeklyModelPct: weeklyModel?.pct ?? null,
    weeklyModelResetAt: weeklyModel?.resetsAt ?? null,
    sections,
    confidence: session?.pct != null && weeklyAll?.pct != null ? 'high' : 'low',
  };
}

/**
 * The folder-trust dialog, across claude versions: older builds ask
 * "Do you trust the files in this folder?", 2.1.x asks "Quick safety check:
 * Is this a project you created or one you trust?" with a "Yes, I trust this
 * folder" option. Whitespace-insensitive — repaints can drop spaces.
 */
export const TRUST_PROMPT_RE =
  /(do\s*you\s*trust|trust\s*the\s*files|trust\s*this\s*folder|quick\s*safety\s*check)/i;

/**
 * First-run theme picker. NOT a logout signal: a *signed-in* account whose
 * config dir hasn't finished onboarding (e.g. a login session killed before
 * it persisted) shows this too. Both the login and usage flows answer it with
 * Enter rather than treating it as logged out. Whitespace-insensitive.
 */
export const THEME_PROMPT_RE = /Choose\s*the\s*text\s*style/i;
/** "Press Enter to continue" interstitial — can recur across onboarding. */
export const CONTINUE_PROMPT_RE = /Press\s*Enter\s*to\s*continue/i;

/**
 * True when the capture shows a genuine login screen — claude has no usable
 * token for this config dir. The theme picker is deliberately excluded (see
 * THEME_PROMPT_RE): it also appears for a signed-in-but-un-onboarded account,
 * so keying off it produced false "not logged in" results. A real login screen
 * is the ground truth here — it reflects whether claude can actually
 * authenticate — whereas probeLogin()'s persisted oauthAccount block is only
 * metadata and can linger after the keychain token is gone. TUI repaints can
 * drop the spaces between words once cursor-positioning escapes are stripped,
 * so patterns are whitespace-insensitive.
 */
export function looksLoggedOut(clean: string): boolean {
  return /(Select\s*login\s*method|Paste\s*code\s*here|Sign\s*in\s*to\s*Claude|\/login\b.*to sign in)/i.test(
    clean,
  );
}

/**
 * True when claude's /usage panel shows its rate-limit error instead of the
 * usage table: "Error: Usage endpoint is rate limited. Please try again in a
 * moment." This is a per-account throttle on the usage endpoint — most often
 * tripped when the SAME account has another live claude session (interactive
 * CLI, IDE extension, agent run) hitting it, or by checking it too frequently.
 * Whitespace-insensitive: TUI repaints drop spaces once escapes are stripped.
 */
export function looksRateLimited(clean: string): boolean {
  return /(usage\s*endpoint\s*is\s*rate\s*limited|rate\s*limited\.?\s*please\s*try\s*again)/i.test(clean);
}
