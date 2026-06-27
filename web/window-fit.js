import { $ } from './dom.js';
import { invoke } from './api.js';

// Show at most this many accounts before the list starts to scroll.
export const MAX_VISIBLE_ACCOUNTS = 5;

// Coalesce a burst of fitWindow() calls into a single resize. A usage check
// fires many usage-status/usage-result events, each of which re-renders the
// cards and calls fitWindow(); left uncoalesced that became dozens of identical
// win:resize calls per second, and the resulting setBounds storm on the
// frameless macOS *vibrancy* window crashed the renderer/compositor (the
// recurring "render-process-gone:crashed"). We cancel any pending frame so only
// the last call in a burst runs, and skip the IPC entirely when the computed
// height hasn't changed — so a steady-state re-render costs zero resizes.
let pendingFrame = 0;
let lastSent = -1;

// Size the popover to its content so it isn't empty with one account, capped at
// MAX_VISIBLE_ACCOUNTS so a long list scrolls instead of filling the screen.
export function fitWindow() {
  if (pendingFrame) cancelAnimationFrame(pendingFrame);
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    const content = document.querySelector('.content');
    const cards = $('#cards');
    if (!content || !cards) return;

    // Everything above the scrollable list (header + action bar + separator).
    // The list is the last in-flow element, so its top edge is the full chrome.
    const chrome = content.getBoundingClientRect().top;

    // #cards' own height is the intrinsic content height (the .content flex box
    // would report its stretched height instead).
    let contentH = cards.offsetHeight;
    const accts = cards.querySelectorAll('.acct');
    if (accts.length > MAX_VISIBLE_ACCOUNTS) {
      // Cap to the bottom of the Nth account. Use bounding rects (not summed
      // offsetHeights) so the separators' vertical margins are included.
      const top = cards.getBoundingClientRect().top;
      const cut = accts[MAX_VISIBLE_ACCOUNTS - 1].getBoundingClientRect().bottom;
      contentH = cut - top;
    }
    let target = Math.ceil(chrome + contentH);

    // The sign-in sheet is a fixed overlay centered in the window; if the window
    // is shorter than the sheet it gets clipped (the body is overflow:hidden).
    // While it's open, grow the window to fit the sheet (+ the overlay's 14px
    // top/bottom padding) so nothing is cut off.
    const modal = document.getElementById('login-modal');
    if (modal && !modal.classList.contains('hidden')) {
      const sheet = modal.querySelector('.sheet');
      if (sheet) target = Math.max(target, Math.ceil(sheet.offsetHeight + 28));
    }
    // Unchanged height → don't touch the window. This is what stops the resize
    // storm: re-renders during a check recompute the same target repeatedly.
    if (target === lastSent) return;
    lastSent = target;
    invoke('win:resize', { height: target }).catch(() => {});
  });
}
