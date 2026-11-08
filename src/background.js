import { AppError, applySpend, balanceOf, createCard, cleanLast4, deleteCard, requireCard, setBalance, undoEntry } from './lib/cards.js';
import { allMerchants, conflictingMerchant, customMerchant, findMerchantByHost, originPatterns, parseDomains } from './lib/match.js';
import { loadState, mutate, withLock } from './lib/store.js';
import { createVault, decodeCode, encodeCode, forgetKey, openVault, recallKey, rememberKey } from './lib/vault.js';
import { applyImport, buildExport } from './lib/transfer.js';
import { disconnect, getToken, isConfigured } from './lib/gmail.js';
import { runScan } from './lib/scanner.js';

const SCRIPT_ID = 'gift-card-toast';
const SCAN_ALARM = 'gmail-scan';
const SEEN_PREFIX = 'seen:';
const DAY = 86_400_000;

let catalog = null;

async function getCatalog() {
  if (!catalog) catalog = await (await fetch(chrome.runtime.getURL('data/merchants.json'))).json();
  return catalog;
}

async function merchantsFor(state) {
  return allMerchants(await getCatalog(), state.customMerchants, state.extraDomains);
}

// Websites the person can take back off a store: anything they added, but
// never a built-in site or a custom store's last one.
function removableDomains(state, merchantId) {
  const custom = state.customMerchants.find((m) => m.id === merchantId);
  return [...(state.extraDomains[merchantId] ?? []), ...(custom && custom.domains.length > 1 ? custom.domains : [])];
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function hasSiteAccess(merchant) {
  return chrome.permissions.contains({ origins: originPatterns(merchant.domains) });
}

function syncContentScripts() {
  return withLock(async () => {
    const state = await loadState();
    const used = new Set(state.cards.map((c) => c.merchantId));
    const matches = [];
    for (const merchant of await merchantsFor(state)) {
      if (!used.has(merchant.id)) continue;
      // Checked per site, so one ungranted website doesn't switch off the rest.
      for (const pattern of originPatterns(merchant.domains)) {
        if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
      }
    }
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (!matches.length) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      return;
    }
    const script = { id: SCRIPT_ID, js: ['src/content/toast.js'], matches, runAt: 'document_idle' };
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  });
}

function scan() {
  return loadState().then(merchantsFor).then(runScan);
}

async function appState() {
  const state = await loadState();
  const merchants = await merchantsFor(state);
  const byId = new Map(merchants.map((m) => [m.id, m]));
  const key = await recallKey();
  const access = new Map();
  for (const id of new Set(state.cards.map((c) => c.merchantId))) {
    if (byId.has(id)) access.set(id, await hasSiteAccess(byId.get(id)));
  }
  const cardName = (id) => {
    const card = state.cards.find((c) => c.id === id);
    if (!card) return 'Removed card';
    return card.label || (card.last4 ? `Card ending ${card.last4}` : 'Gift card');
  };
  return {
    merchants: merchants.map((m) => ({ id: m.id, name: m.name, domains: m.domains })),
    cards: state.cards.map((c) => ({
      id: c.id,
      merchantId: c.merchantId,
      merchantName: byId.get(c.merchantId)?.name ?? 'Unknown store',
      domains: byId.get(c.merchantId)?.domains ?? [],
      removableDomains: removableDomains(state, c.merchantId),
      balanceUrl: byId.get(c.merchantId)?.balanceUrl ?? null,
      label: c.label,
      last4: c.last4,
      note: c.note,
      balanceCents: balanceOf(state, c.id),
      balanceConfirmedAt: c.balanceConfirmedAt,
      hasCode: Boolean(c.code),
      siteAccess: access.get(c.merchantId) ?? false,
    })),
    activity: state.ledger
      .filter((e) => e.source === 'email')
      .sort((a, b) => b.at - a.at)
      .slice(0, 15)
      .map((e) => ({ id: e.id, cents: -e.delta, cardName: cardName(e.cardId), subject: e.subject, at: e.at, undone: Boolean(e.undoneAt) })),
    reviews: state.scan.reviews.map((r) => ({
      ...r,
      merchantName: byId.get(r.merchantId)?.name ?? 'Unknown store',
      candidates: r.candidates.map((id) => ({ id, name: cardName(id) })),
    })),
    alerts: state.scan.alerts.map((a) => ({ ...a, merchantName: byId.get(a.merchantId)?.name ?? 'Unknown store' })),
    settings: state.settings,
    locked: state.settings.storageMode === 'encrypted' && !key,
    gmail: {
      configured: isConfigured(),
      enabled: state.settings.gmailEnabled,
      needsReconnect: state.scan.needsReconnect,
      lastScanAt: state.scan.lastScanAt,
      lastError: state.scan.lastError,
    },
  };
}

async function setStorageMode({ mode, passphrase }) {
  if (!['none', 'local', 'encrypted'].includes(mode)) throw new AppError('invalid-mode');
  const sessionKey = await recallKey();
  await mutate(async (state) => {
    const from = state.settings.storageMode;
    if (mode === from) {
      if (mode === 'encrypted' && !state.vault) {
        const { key, meta } = await createVault(passphrase);
        state.vault = meta;
        await rememberKey(key);
      }
      state.settings.setupDone = true;
      return;
    }
    if (mode === 'none') {
      state.cards.forEach((c) => delete c.code);
      state.vault = null;
      await forgetKey();
    } else {
      let vaultKey = null;
      let meta = null;
      if (mode === 'encrypted') ({ key: vaultKey, meta } = await createVault(passphrase));
      for (const card of state.cards) {
        if (card.code) card.code = await encodeCode(mode, await decodeCode(card.code, sessionKey), vaultKey);
      }
      state.vault = meta;
      if (vaultKey) await rememberKey(vaultKey);
      else await forgetKey();
    }
    state.settings.storageMode = mode;
    state.settings.setupDone = true;
  });
}

const appHandlers = {
  'app/state': appState,

  'cards/add': async ({ card, custom }) => {
    const sessionKey = await recallKey();
    await mutate(async (state) => {
      let merchantId = card.merchantId;
      if (custom) {
        const merchant = customMerchant(custom.name, custom.domains);
        if (!merchant) throw new AppError('invalid-domain');
        merchantId = merchant.id;
        if (!state.customMerchants.some((m) => m.id === merchant.id)) {
          if (conflictingMerchant(await merchantsFor(state), merchant.domains, merchant.id)) throw new AppError('site-in-use');
          state.customMerchants.push(merchant);
        }
      }
      const code = await encodeCode(state.settings.storageMode, card.code, sessionKey);
      createCard(state, { ...card, merchantId, code }, Date.now());
    });
    await syncContentScripts();
  },

  'merchants/addSites': async ({ merchantId, sites }) => {
    const domains = parseDomains(sites);
    if (!domains) throw new AppError('invalid-domain');
    await mutate(async (state) => {
      const merchants = await merchantsFor(state);
      const merchant = merchants.find((m) => m.id === merchantId);
      if (!merchant) throw new AppError('merchant-required');
      if (conflictingMerchant(merchants, domains, merchantId)) throw new AppError('site-in-use');
      const added = domains.filter((d) => !merchant.domains.includes(d));
      state.extraDomains[merchantId] = [...(state.extraDomains[merchantId] ?? []), ...added];
    });
    await syncContentScripts();
  },

  'merchants/removeSite': async ({ merchantId, domain }) => {
    await mutate((state) => {
      if (!removableDomains(state, merchantId).includes(domain)) throw new AppError('entry-not-found');
      const extras = state.extraDomains[merchantId] ?? [];
      if (extras.includes(domain)) {
        state.extraDomains[merchantId] = extras.filter((d) => d !== domain);
      } else {
        const custom = state.customMerchants.find((m) => m.id === merchantId);
        custom.domains = custom.domains.filter((d) => d !== domain);
        custom.emailDomains = custom.emailDomains.filter((d) => d !== domain);
      }
    });
    await syncContentScripts();
  },

  'cards/update': async ({ cardId, label, last4, note, code }) => {
    const sessionKey = await recallKey();
    await mutate(async (state) => {
      const card = requireCard(state, cardId);
      card.label = String(label ?? '').trim().slice(0, 60);
      card.last4 = cleanLast4(last4);
      card.note = String(note ?? '').trim().slice(0, 200);
      if (code) {
        const encoded = await encodeCode(state.settings.storageMode, code, sessionKey);
        if (encoded) card.code = encoded;
      }
    });
  },

  'cards/setBalance': ({ cardId, cents }) => mutate((state) => setBalance(state, cardId, cents, Date.now())),

  'cards/delete': async ({ cardId }) => {
    await mutate((state) => deleteCard(state, cardId));
    await syncContentScripts();
  },

  'cards/getCode': async ({ cardId }) => {
    const state = await loadState();
    return decodeCode(requireCard(state, cardId).code, await recallKey());
  },

  'ledger/undo': ({ entryId }) => mutate((state) => undoEntry(state, entryId, Date.now())),

  'review/resolve': ({ reviewId, cardId }) =>
    mutate((state) => {
      const review = state.scan.reviews.find((r) => r.id === reviewId);
      if (!review || review.kind !== 'pick' || !review.candidates.includes(cardId)) throw new AppError('entry-not-found');
      applySpend(state, cardId, review.amountCents, { orderKey: review.orderKey, subject: review.subject, now: Date.now() });
      state.scan.reviews = state.scan.reviews.filter((r) => r.id !== reviewId);
    }),

  'review/dismiss': ({ reviewId }) =>
    mutate((state) => {
      state.scan.reviews = state.scan.reviews.filter((r) => r.id !== reviewId);
    }),

  'alert/dismiss': ({ alertId }) =>
    mutate((state) => {
      state.scan.alerts = state.scan.alerts.filter((a) => a.id !== alertId);
    }),

  'vault/unlock': async ({ passphrase }) => {
    const state = await loadState();
    if (!state.vault) throw new AppError('invalid-mode');
    await rememberKey(await openVault(state.vault, String(passphrase ?? '')));
  },

  'vault/lock': () => forgetKey(),

  'settings/setMode': setStorageMode,

  'gmail/connect': async () => {
    if (!isConfigured()) throw new AppError('gmail-not-configured');
    await getToken(true);
    await mutate((state) => {
      state.settings.gmailEnabled = true;
      state.scan.needsReconnect = false;
    });
    return scan();
  },

  'gmail/disconnect': async () => {
    await disconnect();
    await mutate((state) => {
      state.settings.gmailEnabled = false;
      state.scan.needsReconnect = false;
    });
  },

  'gmail/scan': () => scan(),

  'transfer/export': async ({ includeCodes, passphrase }) => {
    const state = await loadState();
    const file = await buildExport(state, await merchantsFor(state), { includeCodes, passphrase, sessionKey: await recallKey() }, Date.now());
    return JSON.stringify(file, null, 2);
  },

  'transfer/import': async ({ json, passphrase }) => {
    let file;
    try {
      file = JSON.parse(json);
    } catch {
      throw new AppError('bad-file');
    }
    const sessionKey = await recallKey();
    const result = await mutate(async (state) =>
      applyImport(state, [...(await merchantsFor(state))], file, { passphrase, sessionKey }, Date.now()),
    );
    await syncContentScripts();
    return result;
  },
};

// Everything a merchant-page content script may ask for. The hostname comes
// from the browser's sender info, never from the page.
async function requireCardOnSender(state, cardId, sender) {
  const merchant = findMerchantByHost(await merchantsFor(state), hostOf(sender.url));
  const card = requireCard(state, cardId);
  if (!merchant || card.merchantId !== merchant.id) throw new AppError('forbidden');
  return card;
}

function badgeText(cents) {
  const dollars = Math.round(cents / 100);
  return dollars >= 1000 ? `${Math.floor(dollars / 1000)}k+` : `$${dollars}`;
}

const pageHandlers = {
  'page/visit': async (_message, sender) => {
    const state = await loadState();
    const merchant = findMerchantByHost(await merchantsFor(state), hostOf(sender.url));
    if (!merchant) return { show: false };
    const cards = state.cards
      .filter((c) => c.merchantId === merchant.id)
      .map((c) => ({ card: c, balanceCents: balanceOf(state, c.id) }))
      .filter((c) => c.balanceCents > 0);
    if (!cards.length) return { show: false };

    const totalCents = cards.reduce((sum, c) => sum + c.balanceCents, 0);
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#2b3fd1' });
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: badgeText(totalCents) });

    const seenKey = `${SEEN_PREFIX}${sender.tab.id}:${merchant.id}`;
    const seen = await chrome.storage.session.get(seenKey);
    if (seen[seenKey]) return { show: false };
    await chrome.storage.session.set({ [seenKey]: true });

    const now = Date.now();
    return {
      show: true,
      merchantName: merchant.name,
      balanceUrl: merchant.balanceUrl,
      totalCents,
      cards: cards.map(({ card, balanceCents }) => ({
        id: card.id,
        label: card.label,
        last4: card.last4,
        balanceCents,
        confirmedDaysAgo: Math.floor((now - card.balanceConfirmedAt) / DAY),
        hasCode: Boolean(card.code),
      })),
    };
  },

  'page/getCode': async ({ cardId }, sender) => {
    const state = await loadState();
    const card = await requireCardOnSender(state, cardId, sender);
    return decodeCode(card.code, await recallKey());
  },

  'page/setBalance': ({ cardId, cents }, sender) =>
    mutate(async (state) => {
      await requireCardOnSender(state, cardId, sender);
      setBalance(state, cardId, cents, Date.now());
    }),
};

function route(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new AppError('forbidden');
  const type = message?.type;
  const isExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  const handler = isExtensionPage ? appHandlers[type] : sender.tab ? pageHandlers[type] : undefined;
  if (!handler) throw new AppError('forbidden');
  return handler(message, sender);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => route(message, sender))().then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error.code ?? 'unexpected' }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.create(SCAN_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  syncContentScripts();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SCAN_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  syncContentScripts();
  scan();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM) scan();
});

chrome.permissions.onAdded.addListener(() => syncContentScripts());
chrome.permissions.onRemoved.addListener(() => syncContentScripts());

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null);
  const prefix = `${SEEN_PREFIX}${tabId}:`;
  const stale = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (stale.length) await chrome.storage.session.remove(stale);
});

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/popup.html') });
});
