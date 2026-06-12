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
npm run dev          # → http://127.0.0.1:4747
```

Requires Node 18+ and the `claude` CLI on PATH (`CLAUDE_BIN` env var overrides the binary; `PORT` overrides the port).

### Add an account

1. Type a label (e.g. `work`) and hit **Create + login**. This creates `accounts/work/` as that account's `CLAUDE_CONFIG_DIR` and starts a real `claude` login session, streamed into the page.
2. Drive the onboarding with the on-screen keys (↑ ↓ ⏎), pick *Claude account with subscription*; your browser may open by itself, otherwise click the OAuth URL that appears.
3. Sign in in the browser, then paste the code back into the session input if prompted.
4. Done — the card shows the signed-in email. Tokens live in that config dir / your OS keychain; this tool never sees or stores them.

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
| `POST` | `/api/accounts` | `{ label }` → create config dir, start login PTY |
| `POST` | `/api/accounts/:label/login` | Start (or reuse) the login PTY |
| `POST` | `/api/accounts/:label/login/stop` | Kill the login PTY |
| `POST` | `/api/accounts/:label/input` | `{ data }` → raw keystrokes into the login PTY |
| `POST` | `/api/usage/check` | `{ labels? }` → run `/usage` on all (or some), return results |
| `WS`   | `/ws` | Login output snapshots, OAuth URLs, usage progress + results |

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
- Login is human-driven by design: the tool surfaces the OAuth URL and forwards your keystrokes, nothing more. Removing an account should be `/logout` in that dir — don't hard-delete config dirs casually.

## Gotchas & limits

- `CLAUDE_CONFIG_DIR` is **stable but undocumented** — it can change without notice.
- **TUI parsing is brittle across Claude Code versions.** Developed and tested against `claude` **2.1.173**, where the panel shows *Current session / Current week (all models) / Current week (Sonnet only)*. The parser is generic over `Current …` sections and keeps a raw-output fallback, but expect breakage on big REPL redesigns — re-run `npm run spike` after upgrading and refresh `test/fixtures/` if needed.
- Captured text can be slightly mangled by TUI repaints (dropped spaces in reset strings); percentages are reliable, the raw panel is always attached.
- **Windows:** Claude Code also keeps global state in `~/.claude.json`, so instances sharing one home directory can collide. Give each account a separate `HOME`, or run under WSL/containers.
- **macOS:** the first spawn per account may trigger a Keychain access prompt — click *Always Allow*.
- This is **unofficial, personal-use automation** of the Claude Code CLI. Expect breakage on updates; don't run it against accounts you can't afford to re-login.

## Background

Original design notes: [claude-quota-monitor-plan.md](claude-quota-monitor-plan.md). Related: [anthropics/claude-code#33430](https://github.com/anthropics/claude-code/issues/33430) (CLAUDE_CONFIG_DIR docs request), [#32796](https://github.com/anthropics/claude-code/issues/32796) / [#44328](https://github.com/anthropics/claude-code/issues/44328) (headless usage feature requests).
