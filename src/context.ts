import type { BrowserWindow, Tray } from 'electron';
import type { LoginManager } from './logins.js';
import type { UsageResult } from './types.js';

/**
 * Shared, mutable app state plus the two "notify a surface" helpers, threaded
 * through every shell module (window/tray/ipc/repair) and the usage
 * orchestrator. main.ts owns construction and lifecycle; everything else takes
 * a ctx so no module reaches for a global. `win`/`tray` are filled in when their
 * controllers create them.
 */
export interface AppContext {
  win: BrowserWindow | null;
  tray: Tray | null;
  logins: LoginManager;
  /** Latest usage result per label — drives the menu-bar badge. */
  readonly lastResults: Map<string, UsageResult>;
  /** Labels with an in-flight usage check (mirrors the old server-side guard). */
  readonly checking: Set<string>;
  /** Push an IPC event to the renderer (no-op if the popover is gone). */
  send(channel: string, payload: unknown): void;
  /** Recompute the menu-bar title + tooltip from the latest results. */
  updateBadge(): void;
}

/**
 * Build the context. `makeLogins` receives the (already-wired) ctx so the
 * LoginManager's event callbacks can `ctx.send(...)` — resolving the chicken/egg
 * between send (needs win) and logins (needs send).
 */
export function createContext(makeLogins: (ctx: AppContext) => LoginManager): AppContext {
  const ctx: AppContext = {
    win: null,
    tray: null,
    // Filled in immediately below; declared here so the literal satisfies AppContext.
    logins: undefined as unknown as LoginManager,
    lastResults: new Map<string, UsageResult>(),
    checking: new Set<string>(),

    send(channel, payload) {
      if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload);
    },

    // Worst-case usage % across accounts → a compact menu-bar readout.
    updateBadge() {
      const tray = ctx.tray;
      if (!tray) return;
      let worst: number | null = null;
      for (const r of ctx.lastResults.values()) {
        for (const s of r.parsed?.sections ?? []) {
          if (s.pct != null && (worst == null || s.pct > worst)) worst = s.pct;
        }
      }
      tray.setTitle(worst == null ? '' : ` ${worst}%`);
      const lines = [...ctx.lastResults.values()]
        .map((r) => {
          const top = r.parsed?.sections?.reduce<number | null>(
            (m, s) => (s.pct != null && (m == null || s.pct > m) ? s.pct : m),
            null,
          );
          return `${r.label}: ${top == null ? '—' : top + '%'}`;
        })
        .join(' · ');
      tray.setToolTip(lines ? `Claude Quota — ${lines}` : 'Claude Quota Monitor');
    },
  };

  ctx.logins = makeLogins(ctx);
  return ctx;
}
