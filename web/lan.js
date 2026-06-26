// LAN account lending UI — the lend (show PIN, wait) and receive (enter
// address + PIN) halves of the #lan-modal sheet. Talks to the main process over
// the lan:* IPC channels; the lend outcome arrives as a `lan-lend-status` push
// routed here by events.js. Sits below events/modal in the import graph.
import { state } from './state.js';
import { $, refreshIcons } from './dom.js';
import { invoke } from './api.js';
import { fitWindow } from './window-fit.js';
import { loadAccounts } from './actions.js';

function showLan(show) {
  $('#lan-modal').classList.toggle('hidden', !show);
  fitWindow();
}

/** Closing the sheet also tears down any active lend server. */
export function closeLan() {
  invoke('lan:lend-stop').catch(() => {});
  showLan(false);
}

// ── lend (this PC hands an account out) ───────────────────────────────────────

export async function lendAccount(label) {
  const acc = state.accounts.find((a) => a.label === label);
  $('#lan-recv').classList.add('hidden');
  $('#lan-lend').classList.remove('hidden');
  $('#lan-title').textContent = 'Lend account';
  $('#lan-lend-sub').textContent = (acc && acc.email) || label;
  $('#lan-pin').textContent = '····';
  $('#lan-addr').textContent = 'starting…';
  $('#lan-lend-status').textContent = 'starting…';
  showLan(true);
  refreshIcons();
  try {
    const r = await invoke('lan:lend-start', { label });
    $('#lan-pin').textContent = r.pin;
    $('#lan-addr').textContent = `${r.host}:${r.port}`;
    $('#lan-lend-status').textContent = 'waiting for the other PC…';
    fitWindow();
  } catch (err) {
    $('#lan-lend-status').textContent = `could not start: ${err.message}`;
  }
}

/** Routed here from events.js when the main process reports the lend outcome. */
export function onLendStatus(m) {
  const el = $('#lan-lend-status');
  if (!el || $('#lan-lend').classList.contains('hidden')) return;
  if (m.state === 'done') el.textContent = '✓ sent — the account is now on the other PC';
  else if (m.state === 'failed') el.textContent = `stopped: ${m.message}`;
  else if (m.state === 'expired') el.textContent = 'window expired — close and lend again';
  fitWindow();
}

// ── receive (this PC takes an account in) ─────────────────────────────────────

export function openReceive() {
  $('#lan-lend').classList.add('hidden');
  $('#lan-recv').classList.remove('hidden');
  $('#lan-title').textContent = 'Receive account';
  $('#lan-recv-addr').value = '';
  $('#lan-recv-pin').value = '';
  $('#lan-recv-status').textContent = '';
  showLan(true);
  refreshIcons();
  $('#lan-recv-addr').focus();
}

export async function submitReceive() {
  const addr = $('#lan-recv-addr').value.trim();
  const pin = $('#lan-recv-pin').value.trim();
  const m = addr.match(/^(.+):(\d+)$/);
  const statusEl = $('#lan-recv-status');
  if (!m) {
    statusEl.textContent = 'enter the address as host:port';
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    statusEl.textContent = 'PIN is 4 digits';
    return;
  }
  statusEl.textContent = 'connecting…';
  fitWindow();
  try {
    await invoke('lan:receive', { host: m[1], port: Number(m[2]), pin });
    statusEl.textContent = '✓ received — added to this PC';
    await loadAccounts();
    setTimeout(() => showLan(false), 1300);
  } catch (err) {
    statusEl.textContent = `failed: ${err.message}`;
    fitWindow();
  }
}
