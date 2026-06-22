// The human-free part of `claude` onboarding: a table of known screens and the
// keystroke that answers each, plus the matcher LoginManager uses to pick which
// one to fire. Kept separate from the session lifecycle (logins.ts) so the
// "which screens do we auto-advance" knowledge lives in one small, data-driven
// place. Patterns are whitespace-insensitive — TUI repaints can drop spaces.
import { TRUST_PROMPT_RE, THEME_PROMPT_RE, CONTINUE_PROMPT_RE } from './parse.js';

/** Delay between detecting a known screen and answering it, so the menu finishes painting. */
export const AUTO_KEY_DELAY_MS = 400;

export interface AutoRule {
  key: string;
  re: RegExp;
  status: string;
  /** Keystrokes to send when this screen appears (default: Enter). */
  send?: string;
  /** Screens that can appear more than once (e.g. "Press Enter to continue"). */
  repeatable?: boolean;
}

/**
 * Auto-drive the human-free part of onboarding by pressing Enter on each
 * known screen: default theme, "Claude account with subscription" (the
 * pre-selected login method), folder trust, and any "press Enter to
 * continue" interstitial. The actual browser sign-in stays human.
 */
const AUTO_RULES: AutoRule[] = [
  { key: 'theme', re: THEME_PROMPT_RE, status: 'picking default theme' },
  { key: 'method', re: /Select\s*login\s*method/i, status: 'choosing Claude subscription sign-in' },
  { key: 'trust', re: TRUST_PROMPT_RE, status: 'accepting folder trust' },
  { key: 'continue', re: CONTINUE_PROMPT_RE, status: 'continuing', repeatable: true },
  // We pre-seed hasCompletedOnboarding so claude trusts a persisted token and
  // lands in the REPL after sign-in. The side effect: a fresh, token-less
  // account also skips the first-run login wizard and drops into the REPL
  // showing "Not logged in · Run /login" — no OAuth picker. Kick sign-in off
  // ourselves by running /login, which brings up "Select login method" (handled
  // by the rule above). Without this, onboarding stalls here forever.
  { key: 'login', re: /Run\s*\/login\b/i, status: 'opening sign-in', send: '/login\r' },
];

/**
 * Pick the first rule whose screen is present in `fresh` (the newly-seen text)
 * and hasn't already fired — unless it's repeatable. Returns null when no known
 * screen is showing, so the caller does nothing this flush.
 */
export function matchAutoRule(fresh: string, firedRules: Set<string>): AutoRule | null {
  for (const rule of AUTO_RULES) {
    if (!rule.repeatable && firedRules.has(rule.key)) continue;
    if (rule.re.test(fresh)) return rule;
  }
  return null;
}
