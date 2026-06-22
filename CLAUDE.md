# CLAUDE.md

Native macOS menu-bar app (Electron) that watches Claude Code usage quota across
multiple accounts. It drives real `claude` REPLs over PTYs, runs `/usage` for each
account, and can sign accounts in, open per-account CLIs, and switch the VS Code
extension's account.

## Commands

```bash
npm run build     # tsc → dist/  (the only build step; no bundler)
npm test          # tsx --test test/*.test.ts
npm run app       # build + launch Electron
npm start         # launch Electron against the current dist/
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

This is a menu-bar app, not a web page — there's no browser preview. Verify with
`npm run build` (types) and `npm test` (parse/usage-api logic). For renderer
changes, the module graph can be smoke-loaded headlessly under a stubbed DOM.
Logged-in checks spawn real `claude` processes, so avoid wide auto-checks in any
scripted launch.
