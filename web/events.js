import { state } from './state.js';
import { on } from './api.js';
import { renderCards, updateToolbar } from './cards.js';
import { loadAccounts } from './actions.js';
import { openLogin, setModalStatus, renderModalUrls, loginSucceeded } from './modal.js';

const EVENT_CHANNELS = [
  'login-status',
  'login-url',
  'login-success',
  'login-exit',
  'usage-status',
  'usage-result',
  'check-start',
  'check-done',
  'account-added',
];

// Subscribe to each push channel; reconstruct the old `{ type, ...payload }`
// shape so the handler below is unchanged from the WebSocket version.
export function connectEvents() {
  for (const ch of EVENT_CHANNELS) {
    on(ch, (data) => handleWs({ type: ch, ...(data || {}) }));
  }
}

function handleWs(m) {
  switch (m.type) {
    case 'account-added':
      // Tray-menu "Add account…" started a sign-in — open the login view for it.
      loadAccounts().then(() => openLogin(m.label));
      break;
    case 'login-status':
      if (m.label === state.activeLogin && !state.loginDone) setModalStatus(m.status + '…');
      break;
    case 'login-url': {
      const list = state.urls.get(m.label) || [];
      if (!list.includes(m.url)) list.push(m.url);
      state.urls.set(m.label, list);
      if (m.label === state.activeLogin) renderModalUrls();
      break;
    }
    case 'login-success':
      if (m.label === state.activeLogin) loginSucceeded(m.email);
      else loadAccounts();
      break;
    case 'login-exit':
      if (m.label === state.activeLogin && !state.loginDone) {
        setModalStatus(
          `sign-in ended (exit ${m.exitCode}). If this keeps happening, update Claude Code from the menu (“Repair / update Claude Code”).`,
        );
      }
      loadAccounts();
      break;
    case 'usage-status':
      state.phases.set(m.label, m.phase);
      renderCards();
      break;
    case 'usage-result':
      state.phases.delete(m.result.label);
      state.results.set(m.result.label, m.result);
      renderCards();
      break;
    case 'check-start':
      for (const l of m.labels) {
        state.checking.add(l);
        state.phases.set(l, 'queued');
      }
      updateToolbar();
      renderCards();
      break;
    case 'check-done':
      for (const l of m.labels) {
        state.checking.delete(l);
        state.phases.delete(l);
      }
      updateToolbar();
      renderCards();
      loadAccounts(); // login status may have changed
      break;
  }
}
