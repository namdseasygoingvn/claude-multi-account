'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  accounts: [],
  results: new Map(), // label -> UsageResult
  phases: new Map(), // label -> phase string while a check runs
  urls: new Map(), // label -> [oauth urls]
  activeLogin: null,
  loginDone: false,
  checking: false,
  autoTimer: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
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
  const fill =
    pct != null && pct >= 90
      ? 'bg-system-red'
      : 'bg-gradient-to-r from-[#F3EB35] to-[#F99C24]';
  return `
    <div class="mt-3">
      <div class="flex items-baseline justify-between gap-2 mb-1.5">
        <span class="text-sm text-gray-300">${esc(name)}</span>
        <span class="text-sm font-semibold tabular-nums">${pct == null ? '—' : pct + '%'}</span>
      </div>
      <div class="h-2 rounded-full bg-white/5 overflow-hidden">
        <div class="h-full rounded-full ${fill}" style="width:${Math.min(100, pct ?? 0)}%"></div>
      </div>
      ${resetsAt ? `<div class="text-xs text-gray-500 mt-1">resets ${esc(resetsAt)}</div>` : ''}
    </div>`;
}

function badgeHtml(acc) {
  if (acc.loggedIn) {
    return `
      <span class="inline-flex items-center gap-1.5 text-sm font-medium px-2.5 py-1 rounded-lg bg-system-green/10 border border-system-green/20 text-system-green max-w-full">
        <span class="w-1.5 h-1.5 rounded-full bg-system-green shrink-0"></span>
        <span class="truncate">${esc(acc.email || 'signed in')}</span>
      </span>`;
  }
  return `
    <span class="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-gray-500">
      not signed in
    </span>`;
}

function cardHtml(acc) {
  const r = state.results.get(acc.label);
  const phase = state.phases.get(acc.label);

  let body = '';
  if (phase) {
    body += `
      <div class="flex items-center gap-2 mt-3 text-sm text-gray-400">
        <span class="w-3.5 h-3.5 border-2 border-system-blue border-t-transparent rounded-full animate-spin shrink-0"></span>
        ${esc(phase)}…
      </div>`;
  }
  if (r) {
    if (r.parsed && r.parsed.sections.length) {
      for (const s of r.parsed.sections) {
        body += metricHtml(s.heading.replace(/^Current\s+/i, ''), s.pct, s.resetsAt);
      }
      if (r.parsed.confidence === 'low') {
        body += `<div class="text-xs text-system-blue mt-3">low parse confidence — check the raw output</div>`;
      }
    }
    if (r.error) {
      body += `
        <div class="bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2 mt-3 text-xs text-red-400">
          ${esc(r.error)}
        </div>`;
    }
    if (r.raw) {
      body += `
        <details class="mt-3">
          <summary class="text-[10px] font-bold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-300 transition-colors">
            raw output · ${r.durationMs} ms · ${esc(new Date(r.checkedAt).toLocaleTimeString())}
          </summary>
          <pre class="mt-2 bg-black/40 border border-white/5 rounded-xl p-3 font-mono text-xs text-gray-300 whitespace-pre-wrap break-words max-h-80 overflow-auto">${esc(r.raw)}</pre>
        </details>`;
    }
  } else if (!phase) {
    body += `<div class="text-sm text-gray-600 mt-3">no check yet</div>`;
  }

  // Square (1:1) icon buttons: check this account, sign in, delete.
  const sq =
    'w-8 h-8 inline-flex items-center justify-center shrink-0 rounded-lg border border-white/10 transition-colors';
  const actions = `
    <div class="flex items-center gap-1.5 shrink-0">
      <button class="check-one-btn ${sq} bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
              data-label="${esc(acc.label)}" title="Check usage for this account" ${state.checking ? 'disabled' : ''}>
        <i data-lucide="refresh-cw" class="w-4 h-4"></i>
      </button>
      <button class="login-btn ${sq} bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white"
              data-label="${esc(acc.label)}" title="Sign in this account">
        <i data-lucide="log-in" class="w-4 h-4"></i>
      </button>
      <button class="delete-btn ${sq} bg-white/5 hover:bg-red-500/15 hover:border-red-500/30 text-gray-400 hover:text-red-400"
              data-label="${esc(acc.label)}" title="Delete account">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    </div>`;

  return `
    <article class="glass-panel rounded-2xl p-4 ${state.activeLogin === acc.label && !state.loginDone ? 'ring-1 ring-system-blue/50' : ''}">
      <div class="flex items-center gap-2">
        <div class="flex-1 min-w-0">${badgeHtml(acc)}</div>
        ${actions}
      </div>
      ${body}
    </article>`;
}

function renderCards() {
  const el = $('#cards');
  if (state.accounts.length === 0) {
    el.innerHTML = `
      <div class="col-span-full flex flex-col items-center gap-4 py-16 text-center">
        <div class="w-16 h-16 bg-gradient-to-br from-[#F3EB35] to-[#F99C24] rounded-2xl shadow-lg shadow-[#F99C24]/20 flex items-center justify-center">
          <i data-lucide="users" class="w-8 h-8 text-black"></i>
        </div>
        <div>
          <div class="text-lg font-semibold">No accounts yet</div>
          <div class="text-sm text-gray-500">Click <span class="text-gray-300 font-medium">Add account</span> in the top-right to get started.</div>
        </div>
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
  $('#check-btn').disabled = state.checking;
  $('#check-btn-text').textContent = state.checking ? 'Checking…' : 'Check usage';
}

// ───────────────────────── accounts / usage ─────────────────────────

async function loadAccounts() {
  try {
    const data = await api('/api/accounts');
    state.accounts = data.accounts;
    renderCards();
  } catch (err) {
    setStatus(`failed to load accounts: ${err.message}`);
  }
}

// labels omitted → check every account; pass [label] to check just one.
async function runCheck(labels) {
  if (state.checking) return;
  state.checking = true;
  updateToolbar();
  setStatus('');
  try {
    const body = labels && labels.length ? { labels } : {};
    const data = await api('/api/usage/check', { method: 'POST', body });
    for (const r of data.results) state.results.set(r.label, r);
    if (data.results.length === 0) setStatus('no accounts yet');
  } catch (err) {
    setStatus(`check failed: ${err.message}`);
  } finally {
    state.checking = false;
    state.phases.clear();
    updateToolbar();
    renderCards();
  }
}

async function deleteAccount(label) {
  const acc = state.accounts.find((a) => a.label === label);
  const name = (acc && acc.email) || label;
  if (!confirm(`Delete account "${name}"?\nThis removes it from the monitor and deletes its local session.`)) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(label)}`, { method: 'DELETE' });
    state.results.delete(label);
    state.phases.delete(label);
    await loadAccounts();
  } catch (err) {
    setStatus(`delete failed: ${err.message}`);
  }
}

async function addAccount() {
  try {
    const data = await api('/api/accounts', { method: 'POST', body: {} });
    await loadAccounts();
    openLogin(data.account.label);
  } catch (err) {
    setStatus(`add failed: ${err.message}`);
  }
}

// ───────────────────────── login modal ─────────────────────────

function showModal(show) {
  $('#login-modal').classList.toggle('hidden', !show);
  $('#login-modal').classList.toggle('flex', show);
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
    await api(`/api/accounts/${encodeURIComponent(label)}/login`, { method: 'POST' });
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
        <a href="${esc(u)}" target="_blank" rel="noopener noreferrer"
           class="text-sm text-system-blue hover:underline underline-offset-2 break-all leading-snug">
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

// ───────────────────────── websocket ─────────────────────────

function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    handleWs(m);
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

function handleWs(m) {
  switch (m.type) {
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
      state.checking = true;
      for (const l of m.labels) state.phases.set(l, 'queued');
      updateToolbar();
      renderCards();
      break;
    case 'check-done':
      state.checking = false;
      state.phases.clear();
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
  const wrap = $('#auto-interval-wrap');
  wrap.classList.toggle('opacity-40', !on);
  wrap.classList.toggle('pointer-events-none', !on);
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
connectWs();
loadAccounts();
