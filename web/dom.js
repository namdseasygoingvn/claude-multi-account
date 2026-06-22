// Tiny DOM helpers shared by every view. Leaf module — imports nothing.

export const $ = (sel) => document.querySelector(sel);

/** HTML-escape a value for safe interpolation into template strings. */
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

/** Set the header status line. */
export function setStatus(text) {
  $('#status').textContent = text;
}

/** Re-render any <i data-lucide> placeholders into SVGs. */
export function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}
