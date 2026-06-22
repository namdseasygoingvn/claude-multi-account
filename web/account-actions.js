import { state } from './state.js';

/**
 * The trailing icon-buttons on each account card, as data.
 *
 * Each entry describes ONE ability's appearance:
 *   id        unique key; also the `data-action` used for click dispatch
 *   icon      lucide icon name
 *   label     aria-label / hover tooltip — string or (acc) => string
 *   cls       extra button classes — string or (acc) => string (optional)
 *   disabled  (acc) => boolean — render the button disabled (optional)
 *
 * To add an ability: add an entry here (appearance) and map its `id` to a
 * handler in ACTION_HANDLERS in app.js (behavior). cards.js renders these and a
 * single delegated listener dispatches by `id`, so there is no per-button
 * wiring to keep in sync.
 */
export const ACCOUNT_ACTIONS = [
  { id: 'check', icon: 'refresh-cw', label: 'Check usage', disabled: (a) => state.checking.has(a.label) },
  { id: 'cli', icon: 'terminal', label: 'Open CLI terminal' },
  {
    id: 'vscode',
    icon: 'code',
    label: (a) => (state.activeVSCode === a.label ? 'Active in VS Code — reload' : 'Switch VS Code'),
    cls: (a) => (state.activeVSCode === a.label ? 'vs-on' : ''),
  },
  { id: 'login', icon: 'log-in', label: 'Sign in' },
  { id: 'delete', icon: 'trash-2', label: 'Delete account', cls: 'danger' },
];
