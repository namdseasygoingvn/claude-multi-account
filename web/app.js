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
  autoMins: 0,
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
      <span class="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded-lg bg-system-green/10 border border-system-green/20 text-system-green max-w-44">
        <span class="w-1.5 h-1.5 rounded-full bg-system-green shrink-0"></span>
        <span class="truncate normal-case font-medium">${esc(acc.email || 'signed in')}</span>
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

  const signinBtn = `
    <button class="login-btn inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-gray-400 hover:text-white transition-colors"
            data-label="${esc(acc.label)}" title="Sign in this account">
      <i data-lucide="log-in" class="w-3.5 h-3.5"></i>${acc.loggedIn ? '' : 'Sign in'}
    </button>`;

  return `
    <article class="glass-panel rounded-2xl p-4 ${state.activeLogin === acc.label && !state.loginDone ? 'ring-1 ring-system-blue/50' : ''}">
      <div class="flex items-center gap-2">
        <h3 class="text-lg font-semibold flex-1 truncate">${esc(acc.label)}</h3>
        ${badgeHtml(acc)}
        ${signinBtn}
      </div>
      <div class="font-mono text-xs text-gray-600 truncate mt-1" title="${esc(acc.configDir)}">${esc(acc.configDir)}</div>
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
          <div class="text-sm text-gray-500">Add your first account below.</div>
        </div>
      </div>`;
  } else {
    el.innerHTML = state.accounts.map(cardHtml).join('');
  }
  for (const btn of el.querySelectorAll('.login-btn')) {
    btn.addEventListener('click', () => openLogin(btn.dataset.label));
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

async function checkUsage() {
  if (state.checking) return;
  state.checking = true;
  updateToolbar();
  setStatus('');
  try {
    const data = await api('/api/usage/check', { method: 'POST', body: {} });
    for (const r of data.results) state.results.set(r.label, r);
    if (data.results.length === 0) setStatus('no accounts registered');
  } catch (err) {
    setStatus(`check failed: ${err.message}`);
  } finally {
    state.checking = false;
    state.phases.clear();
    updateToolbar();
    renderCards();
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
  $('#modal-label').textContent = label;
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

// ───────────────────────── wiring ─────────────────────────

$('#check-btn').addEventListener('click', checkUsage);

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = $('#add-label').value.trim();
  if (!label) return;
  try {
    await api('/api/accounts', { method: 'POST', body: { label } });
    $('#add-label').value = '';
    await loadAccounts();
    openLogin(label);
  } catch (err) {
    setStatus(`add failed: ${err.message}`);
  }
});

$('#modal-close').addEventListener('click', () => {
  showModal(false);
  state.activeLogin = null;
  renderCards();
});

function renderAutoSeg() {
  for (const btn of $('#auto-seg').querySelectorAll('button')) {
    const active = Number(btn.dataset.mins) === state.autoMins;
    btn.className = active
      ? 'px-2.5 py-1 text-xs rounded-[6px] bg-system-gray3 text-white shadow-sm ring-1 ring-white/5 transition-colors'
      : 'px-2.5 py-1 text-xs rounded-[6px] text-gray-400 hover:text-white transition-colors';
  }
}

$('#auto-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.autoMins = Number(btn.dataset.mins);
  renderAutoSeg();
  if (state.autoTimer) clearInterval(state.autoTimer);
  state.autoTimer = null;
  if (state.autoMins > 0) {
    state.autoTimer = setInterval(checkUsage, state.autoMins * 60_000);
    setStatus(`auto-refresh every ${state.autoMins} min`);
  } else {
    setStatus('');
  }
});

renderAutoSeg();
refreshIcons();
connectWs();
loadAccounts();
