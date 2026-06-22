// Single source of renderer state. Plain object + Maps/Sets; mutated in place by
// actions and IPC events, read by the views. No framework — renders are explicit.
export const state = {
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
export function mainBusy() {
  return state.accounts.length > 0 && state.accounts.every((a) => state.checking.has(a.label));
}
