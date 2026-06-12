'use strict';

const $ = (sel) => document.querySelector(sel);

const KEYMAP = {
  enter: '\r',
  up: '\u001b[A',
  down: '\u001b[B',
  esc: '\u001b',
  1: '1',
  2: '2',
  3: '3',
};

const state = {
  accounts: [],
  results: new Map(), // label -> UsageResult
  phases: new Map(), // label -> phase string while a check runs
  urls: new Map(), // label -> [oauth urls]
  activeLogin: null,
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

// ───────────────────────── cards ─────────────────────────

function barClass(pct) {
  if (pct == null) return '';
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function metricHtml(name, pct, resetsAt) {
  return `
    <div class="metric">
      <div class="metric-head">
        <span>${esc(name)}</span>
        <span class="pct">${pct == null ? '—' : pct + '%'}</span>
      </div>
      <div class="bar"><div class="fill ${barClass(pct)}" style="width:${Math.min(100, pct ?? 0)}%"></div></div>
      ${resetsAt ? `<div class="resets">resets ${esc(resetsAt)}</div>` : ''}
    </div>`;
}

function cardHtml(acc) {
  const r = state.results.get(acc.label);
  const phase = state.phases.get(acc.label);

  let badge;
  if (acc.loggedIn) badge = `<span class="badge ok">${esc(acc.email || 'logged in')}</span>`;
  else badge = '<span class="badge off">not logged in</span>';
  if (acc.loginActive) badge += ' <span class="badge live">login session open</span>';

  let body = '';
  if (phase) body += `<div class="phase">⏳ ${esc(phase)}…</div>`;
  if (r) {
    if (r.parsed && r.parsed.sections.length) {
      for (const s of r.parsed.sections) {
        body += metricHtml(s.heading.replace(/^Current\s+/i, ''), s.pct, s.resetsAt);
      }
      if (r.parsed.confidence === 'low') {
        body += '<div class="note">low parse confidence — check the raw output</div>';
      }
    }
    if (r.error) body += `<div class="error">${esc(r.error)}</div>`;
    if (r.raw) {
      body += `<details><summary>raw output · ${r.durationMs} ms · ${esc(
        new Date(r.checkedAt).toLocaleTimeString(),
      )}</summary><pre>${esc(r.raw)}</pre></details>`;
    }
  } else if (!phase) {
    body += '<div class="note">no check yet</div>';
  }

  return `
    <article class="card ${state.activeLogin === acc.label ? 'active' : ''}">
      <div class="card-head">
        <h3>${esc(acc.label)}</h3>
        <div class="badges">${badge}</div>
        <button class="login-btn" data-label="${esc(acc.label)}">${acc.loginActive ? 'open login' : 'login'}</button>
      </div>
      <div class="card-dir" title="${esc(acc.configDir)}">${esc(acc.configDir)}</div>
      <div class="card-body">${body}</div>
    </article>`;
}

function renderCards() {
  const el = $('#cards');
  if (state.accounts.length === 0) {
    el.innerHTML = '<div class="empty">No accounts yet — add one below.</div>';
    return;
  }
  el.innerHTML = state.accounts.map(cardHtml).join('');
  for (const btn of el.querySelectorAll('.login-btn')) {
    btn.addEventListener('click', () => openLogin(btn.dataset.label));
  }
}

function updateToolbar() {
  $('#check-btn').disabled = state.checking;
  $('#check-btn').textContent = state.checking ? 'Checking…' : 'Check usage';
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

// ───────────────────────── login panel ─────────────────────────

async function openLogin(label) {
  state.activeLogin = label;
  state.urls.set(label, state.urls.get(label) || []);
  $('#login-label').textContent = label;
  $('#login-output').textContent = '(waiting for output…)';
  $('#login-panel').classList.remove('hidden');
  renderUrls();
  renderCards();
  try {
    await api(`/api/accounts/${encodeURIComponent(label)}/login`, { method: 'POST' });
  } catch (err) {
    $('#login-output').textContent = `failed to start login session: ${err.message}`;
  }
  loadAccounts();
  $('#login-text').focus();
}

function renderUrls() {
  const urls = state.urls.get(state.activeLogin) || [];
  $('#login-urls').innerHTML = urls
    .map(
      (u) =>
        `<div class="url-row"><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></div>`,
    )
    .join('');
}

async function sendInput(data) {
  if (!state.activeLogin || !data) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(state.activeLogin)}/input`, {
      method: 'POST',
      body: { data },
    });
  } catch (err) {
    setStatus(`input failed: ${err.message}`);
  }
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
    case 'login-output':
      if (m.label === state.activeLogin) {
        const pre = $('#login-output');
        pre.textContent = m.snapshot;
        pre.scrollTop = pre.scrollHeight;
      }
      break;
    case 'login-url': {
      const list = state.urls.get(m.label) || [];
      if (!list.includes(m.url)) list.push(m.url);
      state.urls.set(m.label, list);
      if (m.label === state.activeLogin) renderUrls();
      break;
    }
    case 'login-exit':
      if (m.label === state.activeLogin) {
        $('#login-output').textContent += `\n\n[login session ended — exit code ${m.exitCode}]`;
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

$('#login-hide').addEventListener('click', () => {
  $('#login-panel').classList.add('hidden');
  state.activeLogin = null;
  renderCards();
});

$('#login-stop').addEventListener('click', async () => {
  if (!state.activeLogin) return;
  await api(`/api/accounts/${encodeURIComponent(state.activeLogin)}/login/stop`, { method: 'POST' }).catch(() => {});
  loadAccounts();
});

$('#login-text').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const input = $('#login-text');
  sendInput(input.value + '\r');
  input.value = '';
});

for (const btn of document.querySelectorAll('.keys button')) {
  btn.addEventListener('click', () => sendInput(KEYMAP[btn.dataset.key] ?? ''));
}

$('#auto-toggle').addEventListener('change', (e) => {
  if (state.autoTimer) clearInterval(state.autoTimer);
  state.autoTimer = null;
  if (e.target.checked) {
    const mins = Math.max(1, Number($('#auto-mins').value) || 15);
    state.autoTimer = setInterval(checkUsage, mins * 60_000);
    setStatus(`auto-refresh every ${mins} min`);
  } else {
    setStatus('');
  }
});

connectWs();
loadAccounts();
