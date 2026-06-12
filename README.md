# Claude Multi-Account Quota Monitor

A local tool that watches the usage quota of **multiple Claude accounts** at once. One button runs `/usage` against every account — each one a *real* `claude` CLI session — and renders the results as cards in a small web UI.

```
┌─────────────┐     HTTP / WS      ┌────────────────────────┐
│   Web UI    │ ─────────────────> │   Backend (Node)       │
│  button +   │ <───────────────── │  • account registry    │
│  result     │   usage results    │  • PTY session manager │
│  cards      │                    │  • /usage parser       │
└─────────────┘                    └───────────┬────────────┘
                                               │ spawns (parallel)
                      ┌────────────────────────┼────────────────────────┐
                      │                        │                        │
               ┌──────▼──────┐          ┌──────▼──────┐          ┌──────▼──────┐
               │ claude PTY  │          │ claude PTY  │          │ claude PTY  │
               │   acc1      │          │   acc2      │          │   acc3      │
               │ CFG_DIR=…/1 │          │ CFG_DIR=…/2 │          │ CFG_DIR=…/3 │
               └─────────────┘          └─────────────┘          └─────────────┘
```

## How it works — two tricks

1. **Multi-account = N isolated config dirs.** Claude Code honors the `CLAUDE_CONFIG_DIR` env var: point it at a folder and *all* state — credentials, history, settings — lives there instead of `~/.claude`. Different dir = a completely separate, simultaneously-logged-in account. You log in once per dir (OAuth in the browser); it persists until you `/logout`.
2. **Usage check = drive the REPL in a PTY.** `/usage` is a REPL-only command with no headless equivalent, so the backend spawns `claude` in a pseudo-terminal (`node-pty`), types `/usage`, waits for the panel to settle (idle-debounce + hard cap), strips ANSI, and parses the numbers. Sessions are ephemeral: spawn → capture → kill.

## Quickstart

```bash
npm install
npm run dev          # → http://127.0.0.1:3000
```

Requires Node 18+ and the `claude` CLI on PATH (`CLAUDE_BIN` env var overrides the binary; `PORT` overrides the port). The web UI loads Tailwind and lucide icons from CDNs, so the first page load needs internet.

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

Click **Check usage** — the backend fans out over all accounts in parallel, one ephemeral PTY each, and streams progress over WebSocket. Optional auto-refresh by interval. `/usage` is a status read, not a model call, so it shouldn't consume quota — but don't poll aggressively.

## CLI spike

Prove the capture works on your machine / Claude Code version without the server:

```bash
npm run spike                            # default ~/.claude account
npm run spike -- --config-dir ./accounts/work
npm run spike -- --save capture.txt     # keep the cleaned capture
```

## API

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/accounts` | List labels + login status |
| `POST` | `/api/accounts` | `{ label }` → create config dir, start auto-driven login session |
| `POST` | `/api/accounts/:label/login` | Start (or reuse) the login session |
| `POST` | `/api/accounts/:label/login/stop` | Kill a login session (it normally stops itself on success) |
| `POST` | `/api/usage/check` | `{ labels? }` → run `/usage` on all (or some), return results |
| `WS`   | `/ws` | Login status/URL/success events, usage progress + results |

A usage result carries the parsed sections (`pct`, `resetsAt` per section), a confidence flag, and the ANSI-stripped raw capture as a fallback — the UI always lets you expand the raw panel when parsing looks off.

## Project structure

```
src/
  server.ts      # express + ws, all endpoints
  registry.ts    # accounts.json ↔ label/config-dir mapping, login probe
  session.ts     # node-pty spawn of the claude REPL
  usage.ts       # send /usage, idle-debounce capture, ephemeral lifecycle
  parse.ts       # strip ANSI/TUI chrome, regex → structured sections
  logins.ts      # interactive login PTYs, snapshot/URL streaming
  types.ts
web/             # vanilla HTML/JS/CSS frontend
scripts/spike.ts # milestone-1 single-account capture proof
test/            # parser tests against a real captured panel
accounts/        # one CLAUDE_CONFIG_DIR per account   (gitignored)
accounts.json    # label → config dir registry          (gitignored)
```

## Security

- The machine ends up holding **live OAuth state for every registered account**. The server binds `127.0.0.1` only — never expose it to the LAN.
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
