import { state } from './state.js';
import { setStatus } from './dom.js';
import { invoke } from './api.js';
import { renderCards, updateToolbar } from './cards.js';

export async function loadAccounts() {
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
export async function runCheck(labels) {
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

// Persist a drag-reordered account list. Reorder local state optimistically (so
// the cards settle into place instantly), then save to disk; on failure, reload
// the on-disk order so the UI never drifts from the truth.
export async function reorderAccounts(orderedLabels) {
  const byLabel = new Map(state.accounts.map((a) => [a.label, a]));
  const next = orderedLabels.map((l) => byLabel.get(l)).filter(Boolean);
  for (const a of state.accounts) if (!next.includes(a)) next.push(a); // keep any not listed
  if (next.length !== state.accounts.length) return; // sanity: don't drop accounts
  state.accounts = next;
  renderCards();
  try {
    await invoke('accounts:reorder', { labels: state.accounts.map((a) => a.label) });
  } catch (err) {
    setStatus(`reorder failed: ${err.message}`);
    await loadAccounts(); // re-sync with on-disk order
  }
}

export async function deleteAccount(label) {
  try {
    await invoke('accounts:remove', { label });
    state.results.delete(label);
    state.phases.delete(label);
    await loadAccounts();
  } catch (err) {
    setStatus(`delete failed: ${err.message}`);
  }
}

export async function openCliFor(label) {
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

export async function switchVSCodeFor(label) {
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
