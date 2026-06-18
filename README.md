# Claude Quota Monitor

A tiny **macOS menu-bar app** that checks the usage quota of **all your Claude accounts** at once. It lives in the menu bar — no terminal, no browser tab. Click the icon, hit **Check usage**, and each account's session / weekly limits show up as cards.

---

## How to open it

### Option A — download the app (easiest)

1. Go to **[Releases](https://github.com/namdseasygoingvn/ezg-claude-multi-account/releases/latest)** and download the **`.dmg`** (Apple Silicon / arm64).
2. Open the `.dmg` and drag **Claude Quota Monitor** into your **Applications** folder.
3. Open it from Applications (or Spotlight). A **gauge icon appears in your menu bar** (top-right).

> **First open is blocked?** The app is ad-hoc signed but not notarized by Apple, so macOS Gatekeeper stops it the first time.
> - Usually: **right-click the app → Open → Open**. After that it opens normally.
> - If macOS instead says it **“is damaged and can’t be opened”**, that's just the download quarantine flag. Clear it once in Terminal, then open normally:
>   ```bash
>   xattr -dr com.apple.quarantine "/Applications/Claude Quota Monitor.app"
>   ```
>
> (There's no Dock icon — it's a menu-bar app.)

### Option B — run it from source

```bash
npm install
npm run rebuild:pty     # one time (rebuilds a native module for Electron)
npm run app             # launches the app — icon appears in the menu bar
```

Run `npm run app` again any time to start it. To build your own `.dmg`, run `npm run dist` (output lands in `dist-app/`).

Either way, you need the `claude` CLI installed. It's found automatically; if yours lives somewhere unusual, set `CLAUDE_BIN=/path/to/claude` before launching.

---

## Where to click

- **Left-click the menu-bar gauge icon** → opens the popover with your account cards. Hit **Check usage** to refresh all of them.
- **Right-click the icon** → menu with **Check usage now**, **Auto-refresh** (off / every N min), **Add account…**, **Open at login**, and **Quit**.
- After a check, the icon shows your **highest usage %** right in the menu bar.

To close the popover, just click anywhere else — it tucks back into the menu bar. The app keeps running until you choose **Quit**.

---

## Adding accounts

**Add a new account:** click **Add account** (or the menu's *Add account…*). A sign-in window opens, your browser pops up the Claude login page, and the app finishes setup by itself — the card then shows that account's email.

> ⚠️ **Your browser decides which account you get.** If you're already signed in to claude.ai, the login may complete instantly with *that* account. Sign in to the right account first, or use a private browser window.

**Watch your existing main account too:** add it to `accounts.json` next to the app:

```json
[
  { "label": "main", "configDir": "/Users/you/.claude" }
]
```

(Use an absolute path — no `~`.)

---

## Good to know

- **Checking usage doesn't spend quota** — `/usage` is just a status read. Still, don't auto-refresh too aggressively.
- **Your logins stay private.** The app never sees or stores tokens — they live in each account's own folder / your macOS Keychain. There's no network server; nothing is exposed.
- **macOS may ask for Keychain access** the first time it checks an account — click *Always Allow*.
- This is **unofficial, personal-use automation** of the Claude CLI. It reads the usage panel from a real `claude` session, so a big CLI redesign can break the parsing — it always shows the raw output as a fallback.

For how it's built, see the source under `src/` (Electron main process) and `web/` (the popover UI).
