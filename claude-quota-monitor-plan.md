# Claude Multi-Account Quota Monitor — Plan

A local tool that logs in multiple Claude accounts (each as a real `claude` CLI session), and on one button click runs `/usage` against all of them, then prints the results to a UI.

---

## Verdict

**Buildable**, because it drives the *real* Claude Code CLI — no reverse-engineered API.

The one hard part: `/usage` is an interactive REPL command with **no headless equivalent** (open feature requests: claude-code #32796, #44328). So you capture it by driving a pseudo-terminal (PTY), sending `/usage`, and parsing the rendered panel. That parsing is the fragile bit.

---

## Core mechanism (two tricks)

**1. Multi-account = N isolated config dirs.**
Claude Code honors the `CLAUDE_CONFIG_DIR` env var. Point it at a folder and *all* state — credentials, history, settings — lives there instead of `~/.claude`. Different dir = completely separate, simultaneously-logged-in account. You log in **once per dir** (OAuth in browser); it persists across reboots until you `/logout`.

**2. Usage check = drive the REPL in a PTY.**
Spawn `claude` with that account's `CLAUDE_CONFIG_DIR`, write `/usage\n`, capture the rendered output, strip ANSI codes, parse the numbers.

---

## Architecture

```
┌─────────────┐     HTTP / WS      ┌────────────────────────┐
│   Web UI    │ ─────────────────> │   Backend (Node)       │
│  button +   │ <───────────────── │  • account registry    │
│  result     │   usage results    │  • PTY session manager │
│  cards      │                    │  • /usage parser       │
└─────────────┘                    └───────────┬────────────┘
                                                │ spawns (parallel)
                       ┌────────────────────────┼────────────────────────┐
                       │                         │                        │
                ┌──────▼──────┐           ┌──────▼──────┐          ┌──────▼──────┐
                │ claude PTY  │           │ claude PTY  │          │ claude PTY  │
                │   acc1      │           │   acc2      │          │   acc3      │
                │ CFG_DIR=…/1 │           │ CFG_DIR=…/2 │          │ CFG_DIR=…/3 │
                └─────────────┘           └─────────────┘          └─────────────┘
```

---

## Components

- **Account registry** — a JSON file mapping a label (`personal`, `work`, …) to its `CLAUDE_CONFIG_DIR` path. *No secrets here* — tokens stay inside each config dir / OS keychain.
- **Session manager** — spawns and tracks PTYs (`node-pty`). Persistent or ephemeral (see below).
- **Usage runner** — writes `/usage`, waits for the panel to finish rendering, returns the raw buffer.
- **Parser** — `strip-ansi` → regex → structured object.
- **HTTP/WS server** — endpoints + optional live streaming.
- **Frontend** — a button and one card/row per account.

---

## Request flow — "Check usage"

1. UI → `POST /api/usage/check` (or a WS message).
2. Backend fans out across all accounts **in parallel** (`Promise.all`). For each:
   1. Spawn `claude` in a PTY with `env.CLAUDE_CONFIG_DIR = <account dir>`.
   2. Wait for the REPL prompt to be ready.
   3. Write `/usage\n`.
   4. Collect output until the panel is fully rendered (idle-debounce + hard cap).
   5. `strip-ansi`, then parse → `{ sessionPct, weeklyAllPct, weeklySonnetPct, sessionResetAt, weeklyResetAt }`.
   6. Kill the PTY (ephemeral) or keep it (persistent).
3. Return the array of results → UI renders the cards.

---

## The hard part — capturing `/usage`

- `/usage` is **REPL-only**. There is no `claude usage` headless command, so a PTY is mandatory; `node-pty` gives a real TTY so the TUI actually renders.
- **Knowing when it's done** is the tricky timing problem. Options:
  - (a) wait for a known footer string inside the panel,
  - (b) debounce on output idle (no new bytes for ~300–400 ms),
  - (c) hard timeout cap.
  - → Use **(b) + (c)** together.
- **Parsing** the rendered panel: it's a TUI box, not JSON. Strip ANSI, regex per line for the labeled percentages and reset times. This is **brittle across Claude Code versions**:
  - pin a known-good Claude Code version,
  - snapshot the expected format,
  - keep a **raw-output fallback** shown in the UI when parse confidence is low.
- **Alternative (not recommended):** intercept the HTTPS request the REPL fires for usage and replay it with the session token. Less robust, undocumented endpoint, more policy-risk than scraping the panel you already paid for.

---

## API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/accounts` | List labels + login status |
| `POST` | `/api/accounts` | `{ label }` → create config dir, launch login PTY, stream OAuth URL to UI |
| `POST` | `/api/usage/check` | `{ labels? }` → run `/usage` on all (or some), return results |
| `WS`   | `/ws` | Live PTY output + progress events |

> **Login is human-driven.** The tool launches `claude` → REPL → `/login` (or `claude auth login`) and surfaces the browser URL. *You* sign in. The tool never touches credentials. Deleting an account = run `/logout` in that dir; don't hard-delete dirs by default (destructive).

---

## Project structure

```
claude-quota-monitor/
├─ package.json
├─ src/
│  ├─ server.ts      # express + ws
│  ├─ registry.ts    # label ↔ config dir
│  ├─ session.ts     # node-pty spawn + lifecycle
│  ├─ usage.ts       # send /usage, capture, idle-debounce
│  ├─ parse.ts       # strip-ansi + regex → structured
│  └─ types.ts
├─ web/
│  ├─ index.html
│  ├─ app.js         # button, fetch, render cards
│  └─ style.css
├─ accounts/         # one CLAUDE_CONFIG_DIR per account (gitignored)
│  ├─ acc1/  acc2/  acc3/
└─ README.md
```

---

## Tech stack

- **Runtime:** Node 18+ (Claude Code needs Node anyway).
- **PTY:** `node-pty`.
- **ANSI:** `strip-ansi`.
- **Server:** `express` + `ws` (or Fastify).
- **Frontend:** vanilla HTML/JS (simplest), or React — or `Ink`/`blessed` for a pure-terminal dashboard if you want it fully CLI-flavored.
- **Language:** TypeScript optional.

---

## Build milestones

1. **Single-account spike** — spawn one `claude` PTY, send `/usage`, dump raw output to console. Prove you can capture the panel at all.
2. **Parser** — strip ANSI, reliably extract the numbers + reset times from the captured text.
3. **Multi-account** — registry + per-account `CLAUDE_CONFIG_DIR`; run checks in parallel.
4. **API + minimal UI** — button → table.
5. **In-app login** — surface the OAuth URL so you can add accounts from the UI.
6. **Polish** — live WS streaming, parse-fail fallback, version pin, optional auto-refresh interval.

---

## Gotchas & risks

- `CLAUDE_CONFIG_DIR` is **stable but undocumented** — it can change without notice.
- **TUI parsing is brittle** across Claude Code versions — pin the version, keep the raw fallback.
- **Windows:** Claude Code also keeps global state in `~/.claude.json`, so instances sharing the same home directory collide. Give each a **separate HOME** per account, or run each in a container / WSL.
- **OAuth can't be headless** and you shouldn't automate credential entry — keep login human-driven.
- `/usage` is a **status read, not a model call**, so it shouldn't consume your message quota — but verify on your plan and don't poll aggressively.
- This is **unofficial / unsupported automation**. Keep it personal-use and expect breakage on Claude Code updates.

---

## Security

- The machine stores **live OAuth tokens for all N accounts**. Run locally; **bind the server to `127.0.0.1` only** — never expose it to the LAN.
- Don't store tokens in the registry; leave them in each config dir / OS keychain.
- `.gitignore` the `accounts/` directory.

---

## Open decisions

- **Persistent vs ephemeral sessions** — ephemeral (spawn fresh per check) is simpler and more robust since `/usage` is stateless. Recommended default.
- **Where config dirs live** — project-local `accounts/` vs `~/.claude-<label>`.
- **macOS keychain vs Linux file creds** — affects portability and containerization.

---

## References

- Claude Code multi-account via `CLAUDE_CONFIG_DIR`:
  - github.com/jmdarre-v/claude-multiprofile
  - github.com/anthropics/claude-code/issues/33430 (docs request — confirms it's undocumented)
  - dev.to/ashishxcode/claude-code-multi-account-setup-without-losing-context-49nf
- Windows `~/.claude.json` collision: joshcgrossman.com/2026/02/04/claude-two-accounts-windows/
- No headless usage command (feature requests): github.com/anthropics/claude-code/issues/32796, issues/44328
- Where usage shows in-product: support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
