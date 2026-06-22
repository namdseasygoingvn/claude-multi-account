// Drag-to-reorder for the account cards. A small grip handle on each card head
// is the ONLY draggable surface, so button clicks and raw-output text selection
// are untouched. On drop we read the new label order straight from the DOM and
// hand it to the injected persist callback (actions.reorderAccounts), which
// updates state, re-renders, and saves to disk. Works identically on macOS and
// Windows — it's plain Chromium HTML5 drag-and-drop. Leaf-ish: imports only dom.
import { $ } from './dom.js';

let dragLabel = null; // label of the card currently being dragged, or null

function clearIndicators(container) {
  for (const c of container.querySelectorAll('.acct.drop-before, .acct.drop-after')) {
    c.classList.remove('drop-before', 'drop-after');
  }
}

/** Where would `over` sit relative to the cursor — drop above it or below it? */
function dropsAfter(over, clientY) {
  const rect = over.getBoundingClientRect();
  return clientY > rect.top + rect.height / 2;
}

/**
 * Wire drag-to-reorder once on the #cards container. The listeners are delegated,
 * so they survive every renderCards() innerHTML swap (same trick as the click
 * dispatch in app.js). `onReorder(labels)` receives the full new label order.
 */
export function initReorder(onReorder) {
  const container = $('#cards');

  container.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('.drag-handle');
    const card = handle && handle.closest('.acct');
    if (!card) {
      e.preventDefault(); // only the grip handle starts a drag — not the whole card
      return;
    }
    dragLabel = card.dataset.label || null;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Some platforms require drag data to be set for the drag to "take".
    try {
      e.dataTransfer.setData('text/plain', dragLabel);
    } catch {
      /* ignore — not all targets allow setData */
    }
  });

  container.addEventListener('dragover', (e) => {
    if (!dragLabel) return;
    e.preventDefault(); // mark this as a valid drop target
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.acct');
    clearIndicators(container);
    if (!over || over.dataset.label === dragLabel) return;
    over.classList.add(dropsAfter(over, e.clientY) ? 'drop-after' : 'drop-before');
  });

  container.addEventListener('drop', (e) => {
    if (!dragLabel) return;
    e.preventDefault();
    const moved = dragLabel;
    const over = e.target.closest('.acct');
    clearIndicators(container);
    dragLabel = null;
    if (!over || over.dataset.label === moved) return;

    // Current on-screen order minus the dragged card, then re-insert it next to
    // the card it was dropped on (above or below, by cursor position).
    const order = [...container.querySelectorAll('.acct')].map((c) => c.dataset.label).filter((l) => l !== moved);
    let idx = order.indexOf(over.dataset.label);
    if (idx === -1) return;
    if (dropsAfter(over, e.clientY)) idx += 1;
    order.splice(idx, 0, moved);
    onReorder(order);
  });

  container.addEventListener('dragend', () => {
    clearIndicators(container);
    const dragging = container.querySelector('.acct.dragging');
    if (dragging) dragging.classList.remove('dragging');
    dragLabel = null;
  });
}
