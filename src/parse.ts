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
const HEADING_RE = /^Current\s*(session|week|month)\b\s*(?:\(\s*([^)]*?)\s*\))?\s*$/i;
const PCT_RE = /(\d{1,3})\s*%\s*used/i;
const RESET_RE = /Resets\s*(.+?)\s*$/i;

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

/** Parse a panel heading line, tolerating spaceless TUI rendering; null if not a heading. */
function parseHeading(line: string): Heading | null {
  const m = line.match(HEADING_RE);
  if (!m) return null;
  const period = m[1].toLowerCase();
  const rawQual = (m[2] ?? '').trim();
  const qualKey = rawQual.replace(/\s+/g, '').toLowerCase();
  const pretty = qualKey ? (QUAL_PRETTY[qualKey] ?? rawQual.replace(/\s+/g, ' ')) : '';
  return { period, qualKey, display: `Current ${period}${pretty ? ` (${pretty})` : ''}` };
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
  const lines = clean.split('\n');
  const byKey = new Map<string, UsageSection>(); // canonical key -> section; insertion order = render order
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeading(lines[i]);
    if (!h) continue;
    let pct: number | null = null;
    let resetsAt: string | null = null;
    for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
      if (parseHeading(lines[j])) break; // ran into the next section
      if (pct === null) {
        const pm = lines[j].match(PCT_RE);
        if (pm) pct = Math.min(100, parseInt(pm[1], 10));
      }
      if (resetsAt === null) {
        const rm = lines[j].match(RESET_RE);
        if (rm) resetsAt = normalizeReset(rm[1]);
      }
    }
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
