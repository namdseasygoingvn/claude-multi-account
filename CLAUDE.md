# CLAUDE.md

Native menu-bar / system-tray app (Electron) for **macOS** and **Windows x64**
that watches Claude Code usage quota across multiple accounts. It drives real
`claude` REPLs over PTYs, runs `/usage` for each account, and can sign accounts
in, open per-account CLIs, and switch the VS Code extension's account.

## Commands

```bash
npm run build     # tsc → dist/  (the only build step; no bundler)
npm test          # tsx --test test/*.test.ts
npm run app       # build + launch Electron
npm start         # launch Electron against the current dist/
npm run dist      # build + electron-builder → installer for the current OS (dist-app/)
npm run spike     # tsx scripts/spike.ts (capture a real /usage REPL stream)
```

`tsc` is `module: NodeNext`, so **intra-repo imports use explicit `.js` extensions**
(`./registry.js`, not `./registry`). The renderer is plain ES modules loaded over
`file://` — relative specifiers there also need the `.js` extension.

## Architecture

Two processes, one shared shape.

**Main process — `src/`** is split into a flat *core* (domain logic, usable from
plain Node: tests, the spike script) and a `src/shell/` *layer* (everything that
touches Electron):

- Core (flat): `registry` `logins` `switcher` `usage` `usage-api` `parse`
  `updater` `claude-health` `keychain` `session` `paths` `types`.
- `bootstrap.ts` — env/PATH fixups + `claude` binary resolution, run first.
- `context.ts` — `AppContext`: the shared mutable state (`win`, `tray`, `logins`,
  `lastResults`, `checking`) plus the two notify helpers (`send`, `updateBadge`).
  **Anything cross-cutting goes through ctx — no module reaches for a global.**
- `usage-orchestrator.ts` — the `/usage` fan-out (grouping by account, the
  VS-Code-held path, the bounded pool).
- `src/shell/{window,tray,repair,ipc}.ts` — each exports a `createX(ctx, deps)`
  factory returning a small controller. **Modules never import each other**;
  `main.ts` composes them and injects cross-module calls as `deps`.
- `main.ts` — composition root ONLY: build ctx, wire controllers, register
  lifecycle. No business logic here.

**Renderer — `web/`** is plain ES modules with a strictly downward import graph
(no cycles): `app.js` → `events` → `modal` → `actions` → `cards` →
`account-actions` → `window-fit` → leaves (`api`, `state`, `dom`). `app.js` is the
entry; `state.js` holds renderer state; `api.js` wraps the `window.api` IPC bridge
(exposed by `preload.mts`).

**Per-account buttons are a registry.** `web/account-actions.js` declares each
button's *appearance* (id, icon, label, disabled); `ACTION_HANDLERS` in `app.js`
maps the id to *behavior*; one delegated listener on `#cards` dispatches by
`data-action`. To add/change an account ability, touch those two spots — never
hand-wire a button + a `querySelectorAll` loop + an IPC call + a handler in four
places.

## Cross-platform (macOS + Windows)

Ships for **macOS** (menu bar, `.dmg`) and **Windows x64** (system tray, NSIS
`.exe`). The rule for any OS difference: **branch on `process.platform` inside the
core module and keep its public API identical** — platform logic never leaks to
callers. Where the core splits:

- `keychain` — macOS stores tokens in the `/usr/bin/security` Keychain; elsewhere
  in a `.credentials.json` file. One `readSecret`/`writeSecret`/`copySecret` API
  covers both.
- `bootstrap` — resolves `claude` per-OS (Unix candidates + `command -v`; Windows
  `.cmd`/`.exe` shim + `where`) and skips `fix-path` (a POSIX shell shim) on Windows.
- `session` + `claude-health` — a non-`.exe` Windows shim (npm's `claude.cmd`)
  can't go through ConPTY/CreateProcess, so it's spawned via `cmd.exe /c`.
- `switcher` — Windows gets its own new-console launcher (`openCliWindows`) and
  `tasklist` VS Code check; the scripted VS Code reload (`osascript`) is macOS-only
  (elsewhere the user is told to reload by hand).
- `updater` — the one-click install picks + runs THIS platform's release asset:
  macOS mounts the `.dmg` and swaps the `.app` bundle in place; Windows runs the
  per-user NSIS `.exe` and quits so it can replace files (its finish step relaunches).
- `shell/tray` + `context` — colored (non-template) tray icon off macOS; the
  worst-% readout is the tray *title* on macOS, the *tooltip* elsewhere.
- `shell/window` — the popover drops below a top tray (macOS menu bar) or rises
  above a bottom one (Windows taskbar), clamped fully on-screen.

**Packaging.** `npm run dist` builds an installer for the current OS;
`.github/workflows/release.yml` runs a macOS + Windows matrix on every push to
`main` and ships both installers in one GitHub Release (Windows = NSIS x64,
per-user, no UAC). Icons come from `scripts/gen-icons.mjs` (dependency-free
PNG/ICO encoders); `scripts/smoke-pty.cjs` is a CI gate proving `node-pty` loads
and spawns a PTY under Electron before packaging.

## Refactor rules

Line count is a smell, not a law. The actual rule: **a file (or function) earns
its place by having one reason to change.** If you can only describe a file with
"and", it's more than one module.

- **File length:** ~200 lines is a prompt to look; ~300 is a prompt to split.
- **Function length:** past ~40 lines, extract a helper.
- **`// ── … ──` banners** mark concerns — when a file grows several, those are
  the cut lines. (That's exactly how the old `main.ts` was decomposed.)
- **Entry files stay wiring-only.** `main.ts` and `web/app.js` import, wire, and
  start — they hold no logic. Keep them that way.
- **Imports point one direction.** Leaf modules (`types`, `paths`, `context`;
  `api`, `state`, `dom`) must not import feature modules. In `src/shell/`, modules
  don't import siblings — compose in `main.ts` via injected `deps`. In `web/`, keep
  the graph acyclic (the order above).
- **Core stays Node-pure.** Don't `import 'electron'` into a core `src/` module;
  Electron-only code lives in `src/shell/`. Tests and `scripts/spike.ts` depend on
  this.
- **Declarative over hand-wired.** Repeated parallel structures (the account
  buttons, the IPC channel list) belong in a data table iterated once, not copied
  per case.

## Verifying changes

This is a menu-bar / tray app, not a web page — there's no browser preview. Verify with
`npm run build` (types) and `npm test` (parse/usage-api logic). For renderer
changes, the module graph can be smoke-loaded headlessly under a stubbed DOM.
Logged-in checks spawn real `claude` processes, so avoid wide auto-checks in any
scripted launch.
