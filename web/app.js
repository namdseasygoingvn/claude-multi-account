'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  accounts: [],
  activeVSCode: null,
  results: new Map(), // label -> UsageResult
  phases: new Map(), // label -> phase string while a check runs
  urls: new Map(), // label -> [oauth urls]
  activeLogin: null,
  loginDone: false,
  checking: new Set(), // labels with an in-flight usage check
  autoTimer: null,
};

// The main "Check usage" button is busy only while every account is being
// checked (i.e. a real "check all"). Reloading one of several accounts leaves
// it — and the other cards' buttons — clickable.
function mainBusy() {
  return state.accounts.length > 0 && state.accounts.every((a) => state.checking.has(a.label));
}

// Talk to the Electron main process over IPC (replaces fetch to the old server).
// Strip Electron's "Error invoking remote method '…':" prefix for clean messages.
async function invoke(channel, payload) {
  try {
    return await window.api.invoke(channel, payload);
  } catch (err) {
    const m = String(err && err.message ? err.message : err);
    throw new Error(m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function setStatus(text) {
  $('#status').textContent = text;
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

// ───────────────────────── cards ─────────────────────────

function metricHtml(name, pct, resetsAt) {
  const high = pct != null && pct >= 90 ? ' high' : '';
  const reset = resetsAt ? ` <span class="metric-reset">· resets ${esc(resetsAt)}</span>` : '';
  return `
    <div class="metric">
      <div class="metric-top">
        <span class="metric-name">${esc(name)}${reset}</span>
        <span class="metric-val">${pct == null ? '—' : pct + '%'}</span>
      </div>
      <div class="bar"><div class="bar-fill${high}" style="width:${Math.min(100, pct ?? 0)}%"></div></div>
    </div>`;
}

function cardHtml(acc) {
  const r = state.results.get(acc.label);
  const phase = state.phases.get(acc.label);

  let body = '';
  if (phase) {
    body += `<div class="phase"><span class="spin"></span>${esc(phase)}…</div>`;
  }
  if (r) {
    if (r.parsed && r.parsed.sections.length) {
      body += '<div class="metrics">';
      for (const s of r.parsed.sections) {
        body += metricHtml(s.heading.replace(/^Current\s+/i, ''), s.pct, s.resetsAt);
      }
      body += '</div>';
      if (r.parsed.confidence === 'low') {
        body += `<div class="hint">low parse confidence — see raw output</div>`;
      }
    }
    if (r.error) {
      body += `<div class="err">${esc(r.error)}</div>`;
    }
    if (r.raw) {
      body += `
        <details class="raw">
          <summary>raw output · ${r.durationMs} ms · ${esc(new Date(r.checkedAt).toLocaleTimeString())}</summary>
          <pre>${esc(r.raw)}</pre>
        </details>`;
    }
  } else if (!phase) {
    body += `<div class="noinfo">no check yet</div>`;
  }

  const dot = `<span class="dot ${acc.loggedIn ? 'on' : 'off'}"></span>`;
  const email = acc.loggedIn
    ? `<span class="email">${esc(acc.email || 'signed in')}</span>`
    : `<span class="email off">not signed in</span>`;

  const vsActive = state.activeVSCode === acc.label;
  // Borderless trailing actions: check, open CLI as this account, switch VS Code, sign in, delete.
  const actions = `
    <span class="acct-actions">
      <button class="check-one-btn ibtn" data-label="${esc(acc.label)}" title="Check usage for this account" ${state.checking.has(acc.label) ? 'disabled' : ''}>
        <i data-lucide="refresh-cw"></i>
      </button>
      <button class="open-cli-btn ibtn" data-label="${esc(acc.label)}" title="Open a new Terminal logged in as this account">
        <i data-lucide="terminal"></i>
      </button>
      <button class="switch-vscode-btn ibtn${vsActive ? ' vs-on' : ''}" data-label="${esc(acc.label)}" title="${vsActive ? 'Active in VS Code — click to reload' : 'Switch VS Code to this account'}">
        <i data-lucide="code"></i>
      </button>
      <button class="login-btn ibtn" data-label="${esc(acc.label)}" title="Sign in this account">
        <i data-lucide="log-in"></i>
      </button>
      <button class="delete-btn ibtn danger" data-label="${esc(acc.label)}" title="Delete account">
        <i data-lucide="trash-2"></i>
      </button>
    </span>`;

  return `
    <div class="acct${state.activeLogin === acc.label && !state.loginDone ? ' active' : ''}">
      <div class="acct-head">${dot}${email}${actions}</div>
      ${body}
    </div>`;
}

function renderCards() {
  const el = $('#cards');
  if (state.accounts.length === 0) {
    el.innerHTML = `
      <div class="empty">No accounts yet.
        <div class="sub">Use “Add account…” below to get started.</div>
      </div>`;
  } else {
    el.innerHTML = state.accounts.map(cardHtml).join('<div class="sep"></div>');
  }
  for (const btn of el.querySelectorAll('.login-btn')) {
    btn.addEventListener('click', () => openLogin(btn.dataset.label));
  }
  for (const btn of el.querySelectorAll('.check-one-btn')) {
    btn.addEventListener('click', () => runCheck([btn.dataset.label]));
  }
  for (const btn of el.querySelectorAll('.delete-btn')) {
    btn.addEventListener('click', () => deleteAccount(btn.dataset.label));
  }
  for (const btn of el.querySelectorAll('.open-cli-btn')) {
    btn.addEventListener('click', () => openCliFor(btn.dataset.label));
  }
  for (const btn of el.querySelectorAll('.switch-vscode-btn')) {
    btn.addEventListener('click', () => switchVSCodeFor(btn.dataset.label));
  }
  // Expanding/collapsing raw output changes the content height — refit then too.
  for (const d of el.querySelectorAll('details.raw')) {
    d.addEventListener('toggle', fitWindow);
  }
  refreshIcons();
  fitWindow();
}

// Show at most this many accounts before the list starts to scroll.
const MAX_VISIBLE_ACCOUNTS = 5;

// Size the popover to its content so it isn't empty with one account, capped at
// MAX_VISIBLE_ACCOUNTS so a long list scrolls instead of filling the screen.
function fitWindow() {
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
    invoke('win:resize', { height: target }).catch(() => {});
  });
}

function updateToolbar() {
  const busy = mainBusy();
  $('#check-btn').classList.toggle('is-busy', busy);
  $('#check-btn-text').textContent = busy ? 'Checking…' : 'Check usage';
}

// ───────────────────────── accounts / usage ─────────────────────────

async function loadAccounts() {
  try {
    const data = await invoke('accounts:list');
    state.accounts = data.accounts;
    state.activeVSCode = data.activeVSCode ?? null;
    renderCards();
  } catch (err) {
    setStatus(`failed to load accounts: ${err.message}`);
  }
}

// labels omitted → check every account; pass [label] to check just one.
async function runCheck(labels) {
  const targets = labels && labels.length ? labels : state.accounts.map((a) => a.label);
  // Skip accounts already mid-check; bail if there's nothing fresh to do.
  const fresh = targets.filter((l) => !state.checking.has(l));
  if (fresh.length === 0) return;
  // Optimistically mark just these labels so their cards spin immediately
  // without locking the other cards' buttons or the main button.
  for (const l of fresh) {
    state.checking.add(l);
    state.phases.set(l, 'queued');
  }
  setStatus('');
  updateToolbar();
  renderCards();
  try {
    const data = await invoke('usage:check', { labels: fresh });
    for (const r of data.results) state.results.set(r.label, r);
  } catch (err) {
    setStatus(`check failed: ${err.message}`);
  } finally {
    // Clear only the labels this call owns — concurrent checks manage theirs.
    for (const l of fresh) {
      state.checking.delete(l);
      state.phases.delete(l);
    }
    updateToolbar();
    renderCards();
  }
}

async function deleteAccount(label) {
  const acc = state.accounts.find((a) => a.label === label);
  const name = (acc && acc.email) || label;
  if (!confirm(`Delete account "${name}"?\nThis removes it from the monitor and deletes its local session.`)) return;
  try {
    await invoke('accounts:remove', { label });
    state.results.delete(label);
    state.phases.delete(label);
    await loadAccounts();
  } catch (err) {
    setStatus(`delete failed: ${err.message}`);
  }
}

async function openCliFor(label) {
  const acc = state.accounts.find((a) => a.label === label);
  const name = (acc && acc.email) || label;
  setStatus(`opening Terminal for ${name}…`);
  try {
    await invoke('cli:open', { label });
    setStatus(`opened Terminal for ${name}`);
  } catch (err) {
    setStatus(`open CLI failed: ${err.message}`);
  }
}

async function switchVSCodeFor(label) {
  const acc = state.accounts.find((a) => a.label === label);
  const name = (acc && acc.email) || label;
  if (!confirm(`Switch VS Code sign-in to "${name}"?\n\nmacOS may ask for Keychain permission — click "Always Allow". VS Code then reloads to apply.`)) return;
  setStatus(`switching VS Code to ${name}…`);
  try {
    const res = await invoke('vscode:switch', { label });
    setStatus((res && res.message) || `VS Code switched to ${name}`);
    await loadAccounts(); // refresh the active marker
  } catch (err) {
    setStatus(`switch failed: ${err.message}`);
    await loadAccounts(); // re-sync the active marker with on-disk truth
  }
}

async function addAccount() {
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

// ───────────────────────── login modal ─────────────────────────

function showModal(show) {
  $('#login-modal').classList.toggle('hidden', !show);
  fitWindow(); // grow to fit the sheet when opening; shrink back to the list when closing
}

function setModalStatus(text) {
  $('#modal-status').textContent = text;
  fitWindow(); // status text can wrap to more lines — keep the sheet fully visible
}

async function openLogin(label) {
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

function renderModalUrls() {
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

function loginSucceeded(email) {
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

// ───────────────────────── main-process events (IPC) ─────────────────────────

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
function connectEvents() {
  for (const ch of EVENT_CHANNELS) {
    window.api.on(ch, (data) => handleWs({ type: ch, ...(data || {}) }));
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

// ───────────────────────── auto-refresh ─────────────────────────

function applyAuto() {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
  const on = $('#auto-toggle').checked;
  $('#auto-interval-wrap').classList.toggle('is-off', !on);
  if (on) {
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

$('#auto-toggle').addEventListener('change', applyAuto);
$('#auto-mins').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3);
});
$('#auto-mins').addEventListener('change', () => {
  if ($('#auto-toggle').checked) applyAuto();
});

refreshIcons();
connectEvents();
// Load accounts, then auto-check usage once so the first quota shows without the
// user having to click "Check usage".
loadAccounts().then(() => {
  if (state.accounts.length) runCheck();
});
