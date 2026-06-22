# Claude Quota Monitor

A tiny **menu-bar / system-tray app** (macOS and Windows) that checks the usage quota of **all your Claude accounts** at once. It lives in the macOS menu bar or the Windows system tray — no terminal, no browser tab. Click the icon, hit **Check usage**, and each account's session / weekly limits show up as cards.

---

## How to open it

### Option A — download the app (easiest)

Grab the latest installer for your OS from **[Releases](https://github.com/namdseasygoingvn/claude-multi-account/releases/latest)**.

**macOS (Apple Silicon):**

1. Download the **`.dmg`**, open it, and drag **Claude Quota Monitor** into your **Applications** folder.
2. Open it from Applications (or Spotlight). A **gauge icon appears in your menu bar** (top-right).

> **First open is blocked?** The app is ad-hoc signed but not notarized by Apple, so macOS Gatekeeper stops it the first time.
> - Usually: **right-click the app → Open → Open**. After that it opens normally.
> - If macOS instead says it **“is damaged and can’t be opened”**, that's just the download quarantine flag. Clear it once in Terminal, then open normally:
>   ```bash
>   xattr -dr com.apple.quarantine "/Applications/Claude Quota Monitor.app"
>   ```

**Windows (x64):**

1. Download the **`…-x64-setup.exe`** and run it. It installs per-user (no admin prompt) and adds a Start-menu entry.
2. Launch **Claude Quota Monitor** — a **gauge icon appears in your system tray** (bottom-right; click the **^** arrow if it's hidden).

> **“Windows protected your PC”?** The installer isn't code-signed yet, so SmartScreen warns on first run. Click **More info → Run anyway**.

> (There's no Dock or taskbar button — it lives in the menu bar / system tray.)

### Option B — run it from source

```bash
npm install
npm run rebuild:pty     # macOS only, one time (rebuilds a native module for Electron)
npm run app             # launches the app — icon appears in the menu bar / tray
```

On **Windows**, skip `rebuild:pty` — node-pty ships an x64 binary that loads as-is. Just `npm install` then `npm run app`.

Run `npm run app` again any time to start it. To build your own installer, run `npm run dist` — `electron-builder` produces a `.dmg` on macOS and a `…-setup.exe` on Windows (output lands in `dist-app/`).

Either way, you need the `claude` CLI installed. It's found automatically; if yours lives somewhere unusual, set `CLAUDE_BIN=/path/to/claude` before launching.

### Updating

On **macOS**, the app checks **[Releases](https://github.com/namdseasygoingvn/claude-multi-account/releases/latest)** for you — on launch and every few hours. When a newer version is out you get a notification, and the right-click menu shows **Download update vX.Y.Z**. Clicking it downloads the new `.dmg` and opens it; just drag the app into **Applications** to replace the old one. (You no longer have to go hunting for releases.) Because the app — not a browser — fetches the `.dmg`, the new version usually opens without the Gatekeeper "damaged" prompt.

On **Windows**, in-app auto-update isn't wired up yet — download the latest **`…-x64-setup.exe`** from Releases and run it to upgrade in place.

---

## Where to click

- **Left-click the menu-bar gauge icon** → opens the popover with your account cards. Hit **Check usage** to refresh all of them.
- **Right-click the icon** → menu with **Check usage now**, **Auto-refresh** (off / every N min), **Add account…**, **Open at login**, **Check for updates**, and **Quit**.
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
- **Your logins stay private.** The app never sees or stores tokens — on macOS they live in your Keychain; on Windows in a private `.credentials.json` inside each account's config dir (the same files Claude Code itself uses). There's no network server; nothing is exposed.
- **macOS may ask for Keychain access** the first time it checks an account — click *Always Allow*. (Windows has no such prompt — the credential files are already private to your user profile.)
- This is **unofficial, personal-use automation** of the Claude CLI. It reads the usage panel from a real `claude` session, so a big CLI redesign can break the parsing — it always shows the raw output as a fallback.

For how it's built, see the source under `src/` (Electron main process) and `web/` (the popover UI).
