import { state, mainBusy } from './state.js';
import { $, esc, refreshIcons } from './dom.js';
import { fitWindow } from './window-fit.js';
import { ACCOUNT_ACTIONS } from './account-actions.js';

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

// Resolve a string-or-(acc)=>string field from an action descriptor.
const field = (v, acc) => (typeof v === 'function' ? v(acc) : v ?? '');

// One trailing icon-button. data-action drives the delegated click dispatch in
// app.js; aria-label is both the a11y name and the CSS hover tooltip
// (.ibtn[aria-label] in index.html) — the native `title` tooltip doesn't render
// on this frameless vibrancy window.
function actionBtnHtml(action, acc) {
  const extra = field(action.cls, acc);
  const label = field(action.label, acc);
  const disabled = action.disabled && action.disabled(acc) ? 'disabled' : '';
  return `<button class="ibtn${extra ? ' ' + extra : ''}" data-action="${action.id}" data-label="${esc(acc.label)}" aria-label="${esc(label)}" ${disabled}><i data-lucide="${esc(action.icon)}"></i></button>`;
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
      // The VS-Code-held state is expected, not a failure — render it calmly.
      body += `<div class="${r.heldByVSCode ? 'hint' : 'err'}">${esc(r.error)}</div>`;
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

  // Grip handle is the only drag surface (see reorder.js); hidden until row hover.
  const handle = `<span class="drag-handle" draggable="true" aria-label="Drag to reorder"><i data-lucide="grip-vertical"></i></span>`;
  const dot = `<span class="dot ${acc.loggedIn ? 'on' : 'off'}"></span>`;
  const email = acc.loggedIn
    ? `<span class="email">${esc(acc.email || 'signed in')}</span>`
    : `<span class="email off">not signed in</span>`;

  const actions = `<span class="acct-actions">${ACCOUNT_ACTIONS.map((a) => actionBtnHtml(a, acc)).join('')}</span>`;

  return `
    <div class="acct${state.activeLogin === acc.label && !state.loginDone ? ' active' : ''}" data-label="${esc(acc.label)}">
      <div class="acct-head">${handle}${dot}${email}${actions}</div>
      ${body}
    </div>`;
}

export function renderCards() {
  const el = $('#cards');
  if (state.accounts.length === 0) {
    el.innerHTML = `
      <div class="empty">No accounts yet.
        <div class="sub">Use “Add account…” below to get started.</div>
      </div>`;
  } else {
    el.innerHTML = state.accounts.map(cardHtml).join('<div class="sep"></div>');
  }
  // Action-button clicks are handled by one delegated listener (app.js). Only
  // the raw-output toggle needs per-element wiring — `toggle` doesn't bubble, so
  // it can't be delegated — and it refits the window when the height changes.
  for (const d of el.querySelectorAll('details.raw')) d.addEventListener('toggle', fitWindow);
  refreshIcons();
  fitWindow();
}

export function updateToolbar() {
  const busy = mainBusy();
  $('#check-btn').classList.toggle('is-busy', busy);
  $('#check-btn-text').textContent = busy ? 'Checking…' : 'Usage';
}
