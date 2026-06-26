// LAN account lending UI — lend (show PIN + wait) and receive (auto-discover a
// lending PC, or enter its address, then PIN). Talks to main over the lan:*
// IPC channels; the lend outcome arrives as a `lan-lend-status` push routed
// here by events.js. Sits below events/modal in the import graph.
import { state } from './state.js';
import { $, esc, refreshIcons, setStatus } from './dom.js';
import { invoke } from './api.js';
import { fitWindow } from './window-fit.js';
import { loadAccounts } from './actions.js';

let selectedPeer = null; // { host, port, name } chosen from the discovered list

function showLan(show) {
  $('#lan-modal').classList.toggle('hidden', !show);
  fitWindow();
}

/** Closing the sheet also tears down any active lend server. */
export function closeLan() {
  invoke('lan:lend-stop').catch(() => {});
  showLan(false);
}

// ── lend (this PC hands accounts out) ─────────────────────────────────────────

async function startLend(labels, subtitle) {
  $('#lan-recv').classList.add('hidden');
  $('#lan-lend').classList.remove('hidden');
  $('#lan-title').textContent = 'Lend account';
  $('#lan-lend-sub').textContent = subtitle;
  $('#lan-pin').textContent = '····';
  $('#lan-addr').textContent = 'starting…';
  $('#lan-lend-status').textContent = 'starting…';
  showLan(true);
  refreshIcons();
  try {
    const r = await invoke('lan:lend-start', { labels });
    $('#lan-pin').textContent = r.pin;
    $('#lan-addr').textContent = `${r.host}:${r.port}`;
    $('#lan-lend-status').textContent = 'waiting for the other PC…';
    fitWindow();
  } catch (err) {
    $('#lan-lend-status').textContent = `could not start: ${err.message}`;
  }
}

export function lendAccount(label) {
  const acc = state.accounts.find((a) => a.label === label);
  startLend([label], (acc && acc.email) || label);
}

export function shareAll() {
  const labels = state.accounts.filter((a) => a.loggedIn).map((a) => a.label);
  if (labels.length === 0) {
    setStatus('no signed-in accounts to share');
    return;
  }
  startLend(labels, `All ${labels.length} signed-in account${labels.length > 1 ? 's' : ''}`);
}

/** Routed here from events.js when the main process reports the lend outcome. */
export function onLendStatus(m) {
  const el = $('#lan-lend-status');
  if (!el || $('#lan-lend').classList.contains('hidden')) return;
  if (m.state === 'done') el.textContent = `✓ ${m.message} to the other PC`;
  else if (m.state === 'failed') el.textContent = `stopped: ${m.message}`;
  else if (m.state === 'expired') el.textContent = 'window expired — close and lend again';
  fitWindow();
}

// ── receive (this PC takes accounts in) ───────────────────────────────────────

export function openReceive() {
  $('#lan-lend').classList.add('hidden');
  $('#lan-recv').classList.remove('hidden');
  $('#lan-title').textContent = 'Receive account';
  selectedPeer = null;
  $('#lan-recv-addr').value = '';
  $('#lan-recv-addr').classList.add('hidden');
  $('#lan-recv-pin').value = '';
  $('#lan-recv-status').textContent = '';
  showLan(true);
  refreshIcons();
  scanPeers();
}

async function scanPeers() {
  const list = $('#lan-peers');
  list.innerHTML = '<div class="lan-scanning"><span class="spin"></span>scanning the network…</div>';
  fitWindow();
  let peers = [];
  try {
    peers = await invoke('lan:discover');
  } catch {
    peers = [];
  }
  if (!peers.length) {
    list.innerHTML = '<div class="lan-none">No lending PCs found. Make sure the other PC clicked “Lend”, then Rescan — or enter its address manually.</div>';
  } else {
    list.innerHTML = peers
      .map(
        (p) =>
          `<button class="lan-peer" data-host="${esc(p.host)}" data-port="${p.port}" data-name="${esc(p.name)}">
             <span class="lan-peer-name">${esc(p.name)}</span>
             <span class="lan-peer-meta">${p.count} account${p.count === 1 ? '' : 's'} · ${esc(p.host)}</span>
           </button>`,
      )
      .join('');
  }
  refreshIcons();
  fitWindow();
}

/** Wire the receive sheet's clicks (called once at startup). */
export function initReceive() {
  $('#lan-rescan').addEventListener('click', scanPeers);

  $('#lan-manual-toggle').addEventListener('click', () => {
    selectedPeer = null;
    for (const el of $('#lan-peers').querySelectorAll('.lan-peer')) el.classList.remove('sel');
    $('#lan-recv-addr').classList.remove('hidden');
    $('#lan-recv-addr').focus();
    fitWindow();
  });

  // Delegated: pick a discovered peer.
  $('#lan-peers').addEventListener('click', (e) => {
    const btn = e.target.closest('.lan-peer');
    if (!btn) return;
    selectedPeer = { host: btn.dataset.host, port: Number(btn.dataset.port), name: btn.dataset.name };
    $('#lan-recv-addr').classList.add('hidden');
    for (const el of $('#lan-peers').querySelectorAll('.lan-peer')) el.classList.toggle('sel', el === btn);
    $('#lan-recv-pin').focus();
  });

  $('#lan-recv-pin').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  $('#lan-recv-go').addEventListener('click', submitReceive);
}

function resolveTarget() {
  const manual = $('#lan-recv-addr');
  if (!manual.classList.contains('hidden') && manual.value.trim()) {
    const m = manual.value.trim().match(/^(.+):(\d+)$/);
    return m ? { host: m[1], port: Number(m[2]) } : null;
  }
  return selectedPeer;
}

async function submitReceive() {
  const status = $('#lan-recv-status');
  const target = resolveTarget();
  const pin = $('#lan-recv-pin').value.trim();
  if (!target) {
    status.textContent = 'pick a PC above, or enter its address as host:port';
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    status.textContent = 'PIN is 4 digits';
    return;
  }
  status.textContent = 'connecting…';
  fitWindow();
  try {
    const r = await invoke('lan:receive', { host: target.host, port: target.port, pin });
    const added = r.added.length;
    const skipped = r.skipped.length;
    status.textContent =
      `✓ received ${added} account${added === 1 ? '' : 's'}` + (skipped ? ` (${skipped} already here)` : '');
    await loadAccounts();
    setTimeout(() => showLan(false), 1400);
  } catch (err) {
    status.textContent = `failed: ${err.message}`;
    fitWindow();
  }
}
