// The detached shell helper that performs the macOS .dmg → .app bundle swap
// AFTER the running app quits (the app can't replace its own running bundle).
// Values arrive as argv (not interpolated), so spaces in "Claude Quota Monitor.app"
// are safe. It backs up the old bundle and restores it if the swap fails, so a
// failed update never leaves the user without a working app.
export const RELAUNCH_SCRIPT = `#!/bin/bash
# args: PID SRC DEST STAGING MOUNT DMG SELF
PID="$1"; SRC="$2"; DEST="$3"; STAGING="$4"; MOUNT="$5"; DMG="$6"; SELF="$7"
# Wait for the running app to fully quit (up to ~60s).
for i in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
/bin/rm -rf "$STAGING" 2>/dev/null
if /usr/bin/ditto "$SRC" "$STAGING"; then
  /bin/mv "$DEST" "$DEST.old" 2>/dev/null
  if /bin/mv "$STAGING" "$DEST"; then
    /bin/rm -rf "$DEST.old" 2>/dev/null
  else
    /bin/mv "$DEST.old" "$DEST" 2>/dev/null
  fi
fi
/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
/usr/bin/hdiutil detach "$MOUNT" -quiet 2>/dev/null
/bin/rm -f "$DMG" 2>/dev/null
/usr/bin/open "$DEST"
/bin/rm -f "$SELF" 2>/dev/null
`;
