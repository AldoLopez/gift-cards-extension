// All wallet data lives under one key in chrome.storage.local. Only the
// service worker writes it, through mutate(), so updates can't interleave.

export function emptyState() {
  return {
    cards: [],
    ledger: [],
    customMerchants: [],
    extraDomains: {},
    settings: { setupDone: false, storageMode: 'local', gmailEnabled: false },
    vault: null,
    scan: { lastScanAt: null, processed: {}, reviews: [], alerts: [], needsReconnect: false, lastError: null },
  };
}

export async function loadState() {
  const { wallet } = await chrome.storage.local.get('wallet');
  const base = emptyState();
  if (!wallet) return base;
  return {
    ...base,
    ...wallet,
    settings: { ...base.settings, ...wallet.settings },
    scan: { ...base.scan, ...wallet.scan },
  };
}

let queue = Promise.resolve();

export function withLock(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// If fn throws, nothing is saved.
export function mutate(fn) {
  return withLock(async () => {
    const state = await loadState();
    const result = await fn(state);
    await chrome.storage.local.set({ wallet: state });
    return result;
  });
}
