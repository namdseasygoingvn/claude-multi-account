// Entry point: wire DOM listeners, dispatch account-card actions, subscribe to
// main-process events, then load. All logic lives in the imported modules.
import { $, setStatus, refreshIcons } from './dom.js';
import { state } from './state.js';
import { renderCards } from './cards.js';
import { loadAccounts, runCheck, deleteAccount, openCliFor, switchVSCodeFor, reorderAccounts } from './actions.js';
import { addAccount, openLogin, showModal } from './modal.js';
import { lendAccount, closeLan, initReceive } from './lan.js';
import { connectEvents } from './events.js';
import { initReorder } from './reorder.js';

// Behavior half of the account-action registry (appearance is in
// account-actions.js). Keys are the action ids; each gets the clicked label.
const ACTION_HANDLERS = {
  check: (label) => runCheck([label]),
  cli: openCliFor,
  vscode: switchVSCodeFor,
  login: openLogin,
  lend: lendAccount,
  delete: deleteAccount,
};

// One delegated listener for every card button — survives re-renders (the
// listener is on #cards, only its children are replaced) so there's no
// per-button rewiring on each render.
$('#cards').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  ACTION_HANDLERS[btn.dataset.action]?.(btn.dataset.label);
});

// ───────────────────────── auto-refresh ─────────────────────────

function applyAuto() {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
  const enabled = $('#auto-toggle').checked;
  $('#auto-interval-wrap').classList.toggle('is-off', !enabled);
  if (enabled) {
    const mins = Math.max(1, parseInt($('#auto-mins').value, 10) || 15);
    state.autoTimer = setInterval(() => runCheck(), mins * 60_000);
    setStatus(`auto-refresh every ${mins} min`);
  } else {
    setStatus('');
  }
}

// ───────────────────────── wiring ─────────────────────────

$('#check-btn').addEventListener('click', () => runCheck());
$('#add-btn').addEventListener('click', addAccount);

$('#modal-close').addEventListener('click', () => {
  showModal(false);
  state.activeLogin = null;
  renderCards();
});

$('#lan-close').addEventListener('click', closeLan);
initReceive(); // wires the receive sheet's scan / peer-pick / manual / submit

$('#auto-toggle').addEventListener('change', applyAuto);
$('#auto-mins').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3);
});
$('#auto-mins').addEventListener('change', () => {
  if ($('#auto-toggle').checked) applyAuto();
});

// Drag the grip handle on a card to reorder accounts; the new order is saved.
initReorder(reorderAccounts);

refreshIcons();
connectEvents();
// Load accounts, then auto-check usage once so the first quota shows without the
// user having to click "Check usage".
loadAccounts().then(() => {
  if (state.accounts.length) runCheck();
});
