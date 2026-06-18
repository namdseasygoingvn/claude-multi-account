# Claude Multi-Account Quota Monitor

A native **macOS menu-bar app** that watches the usage quota of **multiple Claude accounts** at once. It lives in the menu bar (no terminal, no browser tab); click the tray icon for a popover that runs `/usage` against every account — each one a *real* `claude` CLI session — and renders the results as cards.

```
   menu bar ◔ 72%  ──click──▶  ┌───────────────────────┐
   (Tray, NSStatusItem)        │  Popover BrowserWindow │  web/ (cards)
                               └───────────┬────────────┘
                                  preload.mjs (contextBridge)
                                           │ ipcRenderer.invoke / .on
                                ┌──────────▼───────────┐
                                │  Electron main proc  │  registry · logins · usage · session · parse
                                └──────────┬───────────┘
                                           │ spawns (parallel)
                      ┌────────────────────┼────────────────────┐
               ┌──────▼──────┐      ┌──────▼──────┐      ┌──────▼──────┐
               │ claude PTY  │      │ claude PTY  │      │ claude PTY  │
               │ CFG_DIR=…/1 │      │ CFG_DIR=…/2 │      │ CFG_DIR=…/3 │
               └─────────────┘      └─────────────┘      └─────────────┘
```

No network sockets — the renderer talks to the main process over Electron IPC; the main process calls the engine modules directly.

## How it works — two tricks

1. **Multi-account = N isolated config dirs.** Claude Code honors the `CLAUDE_CONFIG_DIR` env var: point it at a folder and *all* state — credentials, history, settings — lives there instead of `~/.claude`. Different dir = a completely separate, simultaneously-logged-in account. You log in once per dir (OAuth in the browser); it persists until you `/logout`.
2. **Usage check = drive the REPL in a PTY.** `/usage` is a REPL-only command with no headless equivalent, so the backend spawns `claude` in a pseudo-terminal (`node-pty`), types `/usage`, waits for the panel to settle (idle-debounce + hard cap), strips ANSI, and parses the numbers. Sessions are ephemeral: spawn → capture → kill.

## Quickstart

```bash
npm install
npm run rebuild:pty   # rebuild node-pty against Electron's ABI (one-time, or after reinstalling deps)
npm run app           # compile TS + launch the menu-bar app
```

A gauge icon appears in the macOS menu bar — click it for the popover. Requires Node 18+ and the `claude` CLI installed (`CLAUDE_BIN` overrides the binary path; otherwise it's auto-resolved from common locations / your login-shell PATH). Tailwind and lucide are vendored locally under `web/vendor/`, so the app works offline.

### Package a `.app` / `.dmg`

```bash
npm run dist          # → dist-app/ (electron-builder, unsigned)
```

`LSUIElement` is set so the packaged app runs menu-bar-only (no Dock icon). For distribution beyond your own machine, add Developer ID signing + notarization.

### Add an account

1. Type a label (e.g. `work`) and hit **Create & sign in**. This creates `accounts/work/` as that account's `CLAUDE_CONFIG_DIR` and starts a real `claude` login session behind the scenes.
2. Onboarding is driven automatically — the tool presses through theme selection, picks *Claude account with subscription*, and accepts the folder-trust prompt. Your browser opens the Claude sign-in page right away (an OAuth URL is also shown as fallback).
3. Finish signing in in the browser. The tool detects the completed authentication, finishes the remaining setup screens, and shuts the session down by itself — the modal closes and the card shows the signed-in email.
4. Tokens live in that config dir / your OS keychain (one keychain item per config dir); this tool never sees or stores them.

> ⚠️ **The browser decides which account you get.** If you're already signed in to claude.ai in your default browser, the OAuth flow can complete instantly with *that* account — no login form shown. Before adding a new account, sign in to the right claude.ai account first (or use a private window for the OAuth URL).

### Monitor your existing main account

Add an entry to `accounts.json` pointing at the default dir:

```json
[
  { "label": "main", "configDir": "/Users/you/.claude" }
]
```

Paths must be absolute (no `~` expansion). The default `~/.claude` is special-cased: the spawned REPL runs without `CLAUDE_CONFIG_DIR` so it behaves exactly like your normal terminal `claude`.

### Check usage

Click **Check usage** — the main process fans out over all accounts in parallel, one ephemeral PTY each, and pushes progress to the popover over IPC. The menu-bar icon also shows the worst-case usage % as a badge, and its right-click menu has **Check usage now** + auto-refresh. Optional auto-refresh by interval. `/usage` is a status read, not a model call, so it shouldn't consume quota — but don't poll aggressively.

## CLI spike

Prove the capture works on your machine / Claude Code version without launching the app (runs under plain Node via tsx):

```bash
npm run spike                            # default ~/.claude account
npm run spike -- --config-dir ./accounts/work
npm run spike -- --save capture.txt     # keep the cleaned capture
```

## IPC contract

The renderer (`web/app.js`) talks to the main process over Electron IPC. Request/response channels (`ipcRenderer.invoke`):

| Channel | Purpose |
|---|---|
| `accounts:list` | List labels + login status |
| `accounts:add` | `{ label? }` → create config dir, start auto-driven login session |
| `accounts:remove` | `{ label }` → stop login, un-register, drop tool-managed dir |
| `login:start` / `login:stop` | Start (or reuse) / kill a login session |
| `login:code` | `{ label, code }` → paste an OAuth code into a running session |
| `usage:check` | `{ labels? }` → run `/usage` on all (or some), return results |
| `shell:openExternal` | open a URL in the default browser |

Push events (`webContents.send` → `ipcRenderer.on`): `login-status`, `login-url`, `login-success`, `login-exit`, `usage-status`, `usage-result`, `check-start`, `check-done`, `account-added`.

A usage result carries the parsed sections (`pct`, `resetsAt` per section), a confidence flag, and the ANSI-stripped raw capture as a fallback — the UI always lets you expand the raw panel when parsing looks off.

## Project structure

```
src/
  main.ts        # Electron entry: tray + popover, IPC handlers, lifecycle
  preload.mts    # contextBridge — whitelists IPC channels (compiles to preload.mjs)
  paths.ts       # data-root resolver (userData when packaged, repo root in dev)
  registry.ts    # accounts.json ↔ label/config-dir mapping, login probe
  session.ts     # node-pty spawn of the claude REPL
  usage.ts       # send /usage, idle-debounce capture, ephemeral lifecycle
  parse.ts       # strip ANSI/TUI chrome, regex → structured sections
  logins.ts      # interactive login PTYs, snapshot/URL streaming
  types.ts
web/             # vanilla HTML/JS/CSS popover UI (vendor/ = local Tailwind + lucide)
assets/          # tray template icon + app icon (generated by scripts/gen-icons.mjs)
scripts/spike.ts # single-account capture proof (plain Node)
test/            # parser tests against a real captured panel
accounts/        # one CLAUDE_CONFIG_DIR per account   (gitignored; userData when packaged)
accounts.json    # label → config dir registry          (gitignored; userData when packaged)
```

## Security

- The machine ends up holding **live OAuth state for every registered account**. There's no network surface: the app is a local Electron process with no listening socket, and the popover loads from `file://` with `contextIsolation` on and `nodeIntegration` off.
- The registry stores labels and paths, **no secrets**. Tokens stay in each config dir / OS keychain. `accounts/` and `accounts.json` are gitignored.
- The browser sign-in itself stays human: the tool only answers onboarding menus (theme, login method, trust, "press Enter") and never touches credentials. Spawned REPLs get a scrubbed environment (`ANTHROPIC_*` / `CLAUDE_CODE_*` removed) so each account can only authenticate via its own config dir.
- Removing an account should be `/logout` in that dir (clears its keychain item) — don't hard-delete config dirs casually.

## Gotchas & limits

- `CLAUDE_CONFIG_DIR` is **stable but undocumented** — it can change without notice.
- **TUI parsing is brittle across Claude Code versions.** Developed and tested against `claude` **2.1.173**, where the panel shows *Current session / Current week (all models) / Current week (Sonnet only)*. The parser is generic over `Current …` sections and keeps a raw-output fallback, but expect breakage on big REPL redesigns — re-run `npm run spike` after upgrading and refresh `test/fixtures/` if needed.
- Captured text can be slightly mangled by TUI repaints (dropped spaces in reset strings); percentages are reliable, the raw panel is always attached.
- **Windows:** Claude Code also keeps global state in `~/.claude.json`, so instances sharing one home directory can collide. Give each account a separate `HOME`, or run under WSL/containers.
- **macOS:** the first spawn per account may trigger a Keychain access prompt — click *Always Allow*.
- This is **unofficial, personal-use automation** of the Claude Code CLI. Expect breakage on updates; don't run it against accounts you can't afford to re-login.

## Background

Original design notes: [claude-quota-monitor-plan.md](claude-quota-monitor-plan.md). Related: [anthropics/claude-code#33430](https://github.com/anthropics/claude-code/issues/33430) (CLAUDE_CONFIG_DIR docs request), [#32796](https://github.com/anthropics/claude-code/issues/32796) / [#44328](https://github.com/anthropics/claude-code/issues/44328) (headless usage feature requests).
