import { $ } from './dom.js';
import { invoke } from './api.js';

// Show at most this many accounts before the list starts to scroll.
export const MAX_VISIBLE_ACCOUNTS = 5;

// Size the popover to its content so it isn't empty with one account, capped at
// MAX_VISIBLE_ACCOUNTS so a long list scrolls instead of filling the screen.
export function fitWindow() {
  requestAnimationFrame(() => {
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
    console.log('[cqm] fitWindow target:', target, 'chrome:', Math.round(chrome), 'cardsH:', contentH);
    invoke('win:resize', { height: target }).catch(() => {});
  });
}
