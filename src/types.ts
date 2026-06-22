export interface AccountConfig {
  label: string;
  /** Absolute path used as CLAUDE_CONFIG_DIR for this account. */
  configDir: string;
}

export interface AccountStatus extends AccountConfig {
  exists: boolean;
  loggedIn: boolean;
  email: string | null;
  loginActive: boolean;
}

export interface UsageSection {
  /** Panel heading as rendered, e.g. "Current session", "Current week (all models)". */
  heading: string;
  /** 0–100, or null if the percentage line was not found. */
  pct: number | null;
  /** Raw text after "Resets", e.g. "11pm (Asia/Saigon)". */
  resetsAt: string | null;
}

export interface ParsedUsage {
  sessionPct: number | null;
  sessionResetAt: string | null;
  weeklyAllPct: number | null;
  weeklyAllResetAt: string | null;
  /** The model-specific weekly line — "Opus" on Max plans, "Sonnet" on some others. */
  weeklyModelLabel: string | null;
  weeklyModelPct: number | null;
  weeklyModelResetAt: string | null;
  /** Every section found, in render order. The UI renders from this so unknown panel variants still display. */
  sections: UsageSection[];
  /** "high" when both session and weekly-all percentages were found. */
  confidence: 'high' | 'low';
}

export interface UsageRun {
  ok: boolean;
  /** false when the REPL showed a login/onboarding screen; null when unknown (e.g. timeout). */
  loggedIn: boolean | null;
  /** true when the /usage panel returned its rate-limit error instead of data. */
  rateLimited?: boolean;
  parsed: ParsedUsage | null;
  /** ANSI-stripped capture tail — the raw fallback shown in the UI when parsing fails. */
  raw: string;
  error: string | null;
  durationMs: number;
}

export interface UsageResult extends UsageRun {
  label: string;
  checkedAt: string;
}
