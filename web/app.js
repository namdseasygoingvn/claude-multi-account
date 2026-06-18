'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  accounts: [],
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
  const high = pct != null && pct >= 90 ? ' bar__fill--high' : '';
  return `
    <div class="metric">
      <div class="metric__top">
        <span class="metric__name">${esc(name)}</span>
        <span class="metric__pct">${pct == null ? '—' : pct + '%'}</span>
      </div>
      <div class="bar">
        <div class="bar__fill${high}" style="width:${Math.min(100, pct ?? 0)}%"></div>
      </div>
      ${resetsAt ? `<div class="metric__reset">resets ${esc(resetsAt)}</div>` : ''}
    </div>`;
}

function badgeHtml(acc) {
  if (acc.loggedIn) {
    return `
      <span class="badge">
        <span class="badge__dot"></span>
        <span class="badge__email">${esc(acc.email || 'signed in')}</span>
      </span>`;
  }
  return `<span class="badge badge--out">not signed in</span>`;
}

function cardHtml(acc) {
  const r = state.results.get(acc.label);
  const phase = state.phases.get(acc.label);

  let body = '';
  if (phase) {
    body += `
      <div class="phase">
        <span class="spinner spinner--sm"></span>
        ${esc(phase)}…
      </div>`;
  }
  if (r) {
    if (r.parsed && r.parsed.sections.length) {
      for (const s of r.parsed.sections) {
        body += metricHtml(s.heading.replace(/^Current\s+/i, ''), s.pct, s.resetsAt);
      }
      if (r.parsed.confidence === 'low') {
        body += `<div class="hint">low parse confidence — check the raw output</div>`;
      }
    }
    if (r.error) {
      body += `<div class="error">${esc(r.error)}</div>`;
    }
    if (r.raw) {
      body += `
        <details class="raw">
          <summary>raw output · ${r.durationMs} ms · ${esc(new Date(r.checkedAt).toLocaleTimeString())}</summary>
          <pre>${esc(r.raw)}</pre>
        </details>`;
    }
  } else if (!phase) {
    body += `<div class="phase" style="color: var(--label-3);">no check yet</div>`;
  }

  // Borderless icon buttons: check this account, sign in, delete.
  const actions = `
    <div class="card__actions">
      <button class="check-one-btn icon-btn icon-btn--sm"
              data-label="${esc(acc.label)}" title="Check usage for this account" ${state.checking.has(acc.label) ? 'disabled' : ''}>
        <i data-lucide="refresh-cw"></i>
      </button>
      <button class="login-btn icon-btn icon-btn--sm"
              data-label="${esc(acc.label)}" title="Sign in this account">
        <i data-lucide="log-in"></i>
      </button>
      <button class="delete-btn icon-btn icon-btn--sm icon-btn--danger"
              data-label="${esc(acc.label)}" title="Delete account">
        <i data-lucide="trash-2"></i>
      </button>
    </div>`;

  return `
    <article class="card ${state.activeLogin === acc.label && !state.loginDone ? 'card--active' : ''}">
      <div class="card__head">
        <div style="flex: 1; min-width: 0;">${badgeHtml(acc)}</div>
        ${actions}
      </div>
      ${body}
    </article>`;
}

function renderCards() {
  const el = $('#cards');
  if (state.accounts.length === 0) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty__icon"><i data-lucide="users"></i></div>
        <div class="empty__title">No accounts yet</div>
        <div class="empty__sub">Click the <strong>+</strong> button in the top-right to add one.</div>
      </div>`;
  } else {
    el.innerHTML = state.accounts.map(cardHtml).join('');
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
  refreshIcons();
}

function updateToolbar() {
  const busy = mainBusy();
  $('#check-btn').disabled = busy;
  $('#check-btn-text').textContent = busy ? 'Checking…' : 'Check usage';
}

// ───────────────────────── accounts / usage ─────────────────────────

async function loadAccounts() {
  try {
    const data = await invoke('accounts:list');
    state.accounts = data.accounts;
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

async function addAccount() {
  try {
    const data = await invoke('accounts:add', {});
    await loadAccounts();
    openLogin(data.account.label);
  } catch (err) {
    setStatus(`add failed: ${err.message}`);
  }
}

// ───────────────────────── login modal ─────────────────────────

function showModal(show) {
  $('#login-modal').classList.toggle('hidden', !show);
}

function setModalStatus(text) {
  $('#modal-status').textContent = text;
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
    await invoke('login:start', { label });
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
}

function loginSucceeded(email) {
  state.loginDone = true;
  $('#modal-progress').classList.add('hidden');
  $('#modal-success').classList.remove('hidden');
  $('#modal-success-email').textContent = email || '';
  refreshIcons();
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
        setModalStatus(`sign-in session ended (exit ${m.exitCode}) — close and try again`);
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
loadAccounts();
