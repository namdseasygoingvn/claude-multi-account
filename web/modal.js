import { state } from './state.js';
import { $, esc, setStatus, refreshIcons } from './dom.js';
import { invoke } from './api.js';
import { fitWindow } from './window-fit.js';
import { renderCards } from './cards.js';
import { loadAccounts } from './actions.js';

export function showModal(show) {
  $('#login-modal').classList.toggle('hidden', !show);
  fitWindow(); // grow to fit the sheet when opening; shrink back to the list when closing
}

export function setModalStatus(text) {
  $('#modal-status').textContent = text;
  fitWindow(); // status text can wrap to more lines — keep the sheet fully visible
}

export async function openLogin(label) {
  state.activeLogin = label;
  state.loginDone = false;
  state.urls.set(label, []);
  const acc = state.accounts.find((a) => a.label === label);
  $('#modal-sub').textContent = acc && acc.email ? acc.email : 'Adding a new account';
  $('#modal-progress').classList.remove('hidden');
  $('#modal-success').classList.add('hidden');
  $('#modal-urls').classList.add('hidden');
  $('#modal-url-list').innerHTML = '';
  setModalStatus('starting claude…');
  showModal(true);
  renderCards();
  try {
    const res = await invoke('login:start', { label });
    if (res && res.blocked) {
      setModalStatus('Claude Code needs updating — fix it from the dialog or the menu, then try again');
    }
  } catch (err) {
    setModalStatus(`failed to start sign-in: ${err.message}`);
  }
}

export function renderModalUrls() {
  const urls = state.urls.get(state.activeLogin) || [];
  if (!urls.length) return;
  $('#modal-urls').classList.remove('hidden');
  $('#modal-url-list').innerHTML = urls
    .map(
      (u) => `
        <a href="${esc(u)}" target="_blank" rel="noopener noreferrer">
          ${esc(u.length > 90 ? u.slice(0, 90) + '…' : u)}
        </a>`,
    )
    .join('');
  fitWindow(); // the URL list adds height to the sheet
}

export function loginSucceeded(email) {
  state.loginDone = true;
  $('#modal-progress').classList.add('hidden');
  $('#modal-success').classList.remove('hidden');
  $('#modal-success-email').textContent = email || '';
  refreshIcons();
  fitWindow(); // success view differs in height from the progress view
  loadAccounts();
  setTimeout(() => {
    if (state.loginDone) {
      showModal(false);
      state.activeLogin = null;
      renderCards();
    }
  }, 2200);
}

export async function addAccount() {
  try {
    const data = await invoke('accounts:add', {});
    await loadAccounts();
    if (data && data.blocked) {
      setStatus('Claude Code needs updating — use “Repair / update Claude Code” in the menu');
      return;
    }
    openLogin(data.account.label);
  } catch (err) {
    setStatus(`add failed: ${err.message}`);
  }
}
