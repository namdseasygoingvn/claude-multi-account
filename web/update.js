// Auto-update row at the bottom of the action bar. One element, fully driven by
// the main process's update snapshot (pushed on the 'update-state' event; an
// initial snapshot is fetched on load). The flow the user sees:
//   Check for updates → New update, download vX → [text progress bar] →
//   vX downloaded · Restart to update → Updating…
// Clicking never closes the popover — the row just advances to the next state.
import { $, esc, refreshIcons } from './dom.js';
import { invoke, on } from './api.js';
import { fitWindow } from './window-fit.js';

// The latest snapshot, so the delegated click knows which action to fire.
let current = { phase: 'idle' };

// A 10-cell text progress bar, e.g. "████░░░░░░" for 40%.
function progressBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round((pct || 0) / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// Map a phase → how the row looks + what a click does.
function view(snap) {
  const tag = snap.tag || 'the update';
  switch (snap.phase) {
    case 'checking':
      return { cls: 'busy', spin: true, text: 'Checking for updates…' };
    case 'available':
      return { cls: 'click', icon: 'download', text: `New update — download ${tag}`, action: 'download' };
    case 'downloading':
      return { cls: 'busy', spin: true, text: 'Downloading', progress: snap.progress };
    case 'ready':
      return { cls: 'click ready', icon: 'rocket', text: `${tag} downloaded · Restart to update`, action: 'install' };
    case 'installing':
      return { cls: 'busy', spin: true, text: 'Updating… restarting' };
    case 'uptodate':
      return { cls: 'done', icon: 'circle-check', text: "You're up to date!" };
    case 'error':
      return { cls: 'click', icon: 'triangle-alert', text: `${snap.error || 'Update failed'} · Retry`, action: 'check' };
    default: // idle — a distinct icon from the "Usage" refresh so the two don't blur
      return { cls: 'click', icon: 'cloud-download', text: 'Check for updates', action: 'check' };
  }
}

function render(snap) {
  current = snap || { phase: 'idle' };
  const row = $('#update-row');
  if (!row) return;
  const v = view(current);
  row.dataset.action = v.action || '';

  const lead = v.spin ? '<span class="spin"></span>' : v.icon ? `<i data-lucide="${v.icon}"></i>` : '';
  let tail = '';
  if (v.progress != null && Number.isFinite(v.progress)) {
    tail = `<span class="u-bar">${progressBar(v.progress)}</span><span class="u-pct">${v.progress}%</span>`;
  } else if (current.phase === 'downloading') {
    tail = '<span class="u-pct">…</span>'; // no Content-Length — show activity, not a %
  }
  row.innerHTML = `<div class="u-item ${v.cls}">${lead}<span class="u-text">${esc(v.text)}</span>${tail}</div>`;
  refreshIcons();
  fitWindow(); // the row's height changes between states; keep the popover flush
}

async function dispatch() {
  const action = $('#update-row').dataset.action;
  if (!action) return; // busy states carry no action
  try {
    render(await invoke(`update:${action}`));
  } catch {
    /* a push 'update-state' event will reconcile the row */
  }
}

export function initUpdate() {
  const row = $('#update-row');
  if (!row) return;
  row.addEventListener('click', dispatch);
  on('update-state', render); // live state from the main process
  invoke('update:state').then(render).catch(() => render({ phase: 'idle' }));
}
