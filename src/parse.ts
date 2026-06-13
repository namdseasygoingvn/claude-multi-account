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

const HEADING_RE = /^(Current\s+(?:session|week|month)\b[^%]*?)\s*$/i;
const PCT_RE = /(\d{1,3})\s*%\s*used/i;
const RESET_RE = /Resets\s+(.+?)\s*$/i;

function normalizeHeading(h: string): string {
  return h.replace(/\s+/g, ' ').trim();
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
  const byHeading = new Map<string, UsageSection>(); // keyed lowercase, insertion order = render order
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (!m) continue;
    const heading = normalizeHeading(m[1]);
    let pct: number | null = null;
    let resetsAt: string | null = null;
    for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
      if (HEADING_RE.test(lines[j])) break; // ran into the next section
      if (pct === null) {
        const pm = lines[j].match(PCT_RE);
        if (pm) pct = Math.min(100, parseInt(pm[1], 10));
      }
      if (resetsAt === null) {
        const rm = lines[j].match(RESET_RE);
        if (rm) resetsAt = rm[1];
      }
    }
    if (pct === null && resetsAt === null) continue; // heading echoed without data (e.g. autocomplete)
    const key = heading.toLowerCase();
    byHeading.delete(key); // re-insert so a later frame also refreshes order
    byHeading.set(key, { heading, pct, resetsAt });
  }

  const sections = [...byHeading.values()];
  const session = byHeading.get('current session') ?? null;
  const weeklyAll = byHeading.get('current week (all models)') ?? null;
  let weeklyModel: UsageSection | null = null;
  let weeklyModelLabel: string | null = null;
  for (const [key, sec] of byHeading) {
    const m = key.match(/^current week \((?!all models)(.+)\)$/);
    if (m) {
      weeklyModel = sec;
      weeklyModelLabel = sec.heading.match(/\((.+)\)/)?.[1] ?? m[1];
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
