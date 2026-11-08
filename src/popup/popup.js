import { bandColor, cardTitle, errorText, h, send, timeAgo } from './ui.js';
import { formatCents, parseDollars } from '../lib/cards.js';
import { conflictingMerchant, originPatterns, parseDomains } from '../lib/match.js';

const app = document.getElementById('app');
const view = { adding: false, addingSite: null, editing: null, expanded: null, deleting: null, revealed: new Map(), error: '' };
let data = null;

async function refresh() {
  data = await send('app/state');
  render();
}

// Runs an action, then redraws. Failures show in the banner slot.
async function act(fn) {
  view.error = '';
  try {
    await fn();
  } catch (error) {
    view.error = errorText(error.code);
  }
  await refresh();
}

// Must be called directly from a click: Chrome requires a user gesture. It isn't
// awaited because the prompt can close the popup, and saving must not depend on it.
function requestSites(domains) {
  chrome.permissions.request({ origins: originPatterns(domains) }).catch(() => {});
}

function banners() {
  const items = [];
  if (!data.settings.setupDone) {
    items.push(h('div', { class: 'banner' }, 'Choose how card numbers are stored. ',
      h('button', { class: 'quiet', onclick: () => chrome.runtime.openOptionsPage() }, 'Open settings')));
  }
  if (data.locked) {
    const input = h('input', { type: 'password', placeholder: 'Passphrase', 'aria-label': 'Passphrase' });
    items.push(h('div', { class: 'banner' }, 'Your card numbers are locked.',
      h('form', { onsubmit: (e) => { e.preventDefault(); act(() => send('vault/unlock', { passphrase: input.value })); } },
        input, h('button', { class: 'btn' }, 'Unlock'))));
  }
  if (data.gmail.needsReconnect) {
    items.push(h('div', { class: 'banner' }, 'Gmail scanning stopped. ',
      h('button', { class: 'quiet', onclick: () => act(() => send('gmail/connect')) }, 'Reconnect Gmail')));
  }
  if (view.error) items.push(h('div', { class: 'banner', role: 'alert' }, view.error));
  return items;
}

function notices() {
  const items = [];
  for (const r of data.reviews) {
    if (r.kind === 'pick') {
      items.push(h('div', { class: 'notice' },
        `${formatCents(r.amountCents)} was paid with a gift card at ${r.merchantName}. Which card was it?`,
        h('div', { class: 'notice-subject' }, r.subject),
        h('div', { class: 'notice-actions' },
          r.candidates.map((c) => h('button', { class: 'quiet', onclick: () => act(() => send('review/resolve', { reviewId: r.id, cardId: c.id })) }, c.name)),
          h('button', { class: 'quiet danger', onclick: () => act(() => send('review/dismiss', { reviewId: r.id })) }, 'Ignore'))));
    } else {
      items.push(h('div', { class: 'notice' },
        `${r.merchantName} charged ${formatCents(r.amountCents)} to a gift card, which is ${formatCents(r.shortCents)} more than its saved balance. The balance is now $0.00, so check it's right.`,
        h('div', { class: 'notice-subject' }, r.subject),
        h('div', { class: 'notice-actions' },
          h('button', { class: 'quiet', onclick: () => act(() => send('review/dismiss', { reviewId: r.id })) }, 'Got it'))));
    }
  }
  for (const a of data.alerts) {
    items.push(h('div', { class: 'notice' },
      `You could have used ${formatCents(a.couldUseCents)} of gift card money on a ${formatCents(a.totalCents)} order at ${a.merchantName}.`,
      h('div', { class: 'notice-subject' }, a.subject),
      h('div', { class: 'notice-actions' },
        h('button', { class: 'quiet', onclick: () => act(() => send('alert/dismiss', { alertId: a.id })) }, 'Dismiss'))));
  }
  return items.length ? [h('h2', {}, 'Needs a look'), items] : [];
}

function scratchPanel(card) {
  const revealed = view.revealed.get(card.id);
  const copyButton = (label, value) => h('button', { class: 'quiet', onclick: () => navigator.clipboard.writeText(value) }, label);
  const reveal = async () => {
    view.error = '';
    try {
      view.revealed.set(card.id, await send('cards/getCode', { cardId: card.id }));
      render();
      requestAnimationFrame(() => document.querySelector(`[data-scratch="${card.id}"]`)?.classList.add('open'));
    } catch (error) {
      view.error = errorText(error.code);
      render();
    }
  };
  return h('div', { class: 'scratch', 'data-scratch': card.id },
    revealed && h('div', {},
      revealed.number && h('div', { class: 'code-line' }, h('span', { class: 'code-value' }, revealed.number), copyButton('Copy', revealed.number)),
      revealed.pin && h('div', { class: 'code-line' }, h('span', { class: 'code-value' }, `PIN ${revealed.pin}`), copyButton('Copy', revealed.pin))),
    h('button', { class: 'scratch-cover', onclick: reveal, tabIndex: revealed ? -1 : 0 }, 'Reveal code'));
}

function editForm(card) {
  const label = h('input', { type: 'text', value: card.label });
  const last4 = h('input', { type: 'text', value: card.last4, inputMode: 'numeric', maxLength: 4 });
  const note = h('input', { type: 'text', value: card.note });
  const number = h('input', { type: 'text', autocomplete: 'off' });
  const pin = h('input', { type: 'text', autocomplete: 'off' });
  const canStore = data.settings.storageMode !== 'none' && !data.locked;
  return h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const code = number.value || pin.value ? { number: number.value, pin: pin.value } : null;
      view.editing = null;
      act(() => send('cards/update', { cardId: card.id, label: label.value, last4: last4.value, note: note.value, code }));
    },
  },
    h('label', { class: 'field' }, h('span', {}, 'Nickname'), label),
    h('label', { class: 'field' }, h('span', {}, 'Last 4 digits'), last4),
    h('label', { class: 'field' }, h('span', {}, 'Note'), note),
    canStore && h('label', { class: 'field' }, h('span', {}, card.hasCode ? 'Replace card number' : 'Card number'), number),
    canStore && h('label', { class: 'field' }, h('span', {}, 'PIN'), pin),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn' }, 'Save changes'),
      h('button', { class: 'quiet', type: 'button', onclick: () => { view.editing = null; render(); } }, 'Cancel')));
}

function sitesBlock(card) {
  const input = h('input', { type: 'text', placeholder: 'example-outlet.com', 'aria-label': 'Website to add' });
  const addSite = (e) => {
    e.preventDefault();
    const domains = parseDomains(input.value);
    if (!domains) {
      view.error = errorText('invalid-domain');
      render();
      return;
    }
    if (conflictingMerchant(data.merchants, domains, card.merchantId)) {
      view.error = errorText('site-in-use');
      render();
      return;
    }
    view.addingSite = null;
    act(() => send('merchants/addSites', { merchantId: card.merchantId, sites: domains }));
  };
  return h('div', {},
    h('div', { class: 'sites-label' }, 'Reminders show on'),
    h('div', { class: 'chips' }, card.domains.map((domain) =>
      h('span', { class: 'chip' }, domain,
        card.removableDomains.includes(domain) && h('button', {
          'aria-label': `Remove ${domain}`,
          onclick: () => act(() => send('merchants/removeSite', { merchantId: card.merchantId, domain })),
        }, '×')))),
    view.addingSite === card.id
      ? h('form', { class: 'site-form', onsubmit: addSite }, input, h('button', { class: 'btn' }, 'Add'))
      : h('button', { class: 'quiet', onclick: () => { view.addingSite = card.id; render(); } }, 'Add a website'));
}

function cardDetail(card) {
  if (view.editing === card.id) return h('div', { class: 'detail' }, editForm(card));
  const input = h('input', { type: 'text', inputMode: 'decimal', value: (card.balanceCents / 100).toFixed(2), 'aria-label': 'New balance in dollars' });
  const saveBalance = (e) => {
    e.preventDefault();
    const cents = parseDollars(input.value);
    if (cents === null) {
      view.error = errorText('invalid-amount');
      render();
      return;
    }
    act(() => send('cards/setBalance', { cardId: card.id, cents }));
  };
  return h('div', { class: 'detail' },
    card.hasCode && scratchPanel(card),
    h('form', { class: 'inline', onsubmit: saveBalance }, input, h('button', { class: 'btn' }, 'Update balance')),
    card.note && h('p', {}, card.note),
    sitesBlock(card),
    h('div', { class: 'links' },
      card.balanceUrl && h('a', { href: card.balanceUrl, target: '_blank', rel: 'noopener' }, 'Check balance on their site'),
      !card.siteAccess && h('button', { class: 'quiet', onclick: () => { requestSites(card.domains); window.setTimeout(refresh, 800); } }, 'Turn on reminders'),
      h('button', { class: 'quiet', onclick: () => { view.editing = card.id; render(); } }, 'Edit'),
      view.deleting === card.id
        ? h('button', { class: 'quiet danger', onclick: () => { view.deleting = null; act(() => send('cards/delete', { cardId: card.id })); } }, 'Confirm delete')
        : h('button', { class: 'quiet danger', onclick: () => { view.deleting = card.id; render(); } }, 'Delete')));
}

function cardRow(card) {
  const open = view.expanded === card.id;
  const subtitle = `${cardTitle(card)}, confirmed ${timeAgo(card.balanceConfirmedAt)}`;
  return h('article', { class: 'card' },
    h('div', { class: 'band', style: `background:${bandColor(card.merchantId)}` }),
    h('button', { class: 'card-head', 'aria-expanded': String(open), onclick: () => { view.expanded = open ? null : card.id; view.deleting = null; view.editing = null; render(); } },
      h('span', {}, h('div', { class: 'merchant' }, card.merchantName), h('div', { class: 'sub' }, subtitle)),
      h('span', { class: 'balance money' }, formatCents(card.balanceCents))),
    open && cardDetail(card));
}

function addForm() {
  const options = [...data.merchants].sort((a, b) => a.name.localeCompare(b.name)).map((m) => h('option', { value: m.id }, m.name));
  const store = h('select', { required: true }, h('option', { value: '' }, 'Choose a store'), options, h('option', { value: '__other' }, 'Another store'));
  const customName = h('input', { type: 'text', placeholder: 'Store name' });
  const customSites = h('input', { type: 'text', placeholder: 'example.com, example-outlet.com' });
  const customFields = h('div', { hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Store name'), customName),
    h('label', { class: 'field' }, h('span', {}, 'Websites'), customSites),
    h('p', { class: 'hint' }, 'If the card works on several sites, separate them with commas.'));
  store.addEventListener('change', () => { customFields.hidden = store.value !== '__other'; });
  const balance = h('input', { type: 'text', inputMode: 'decimal', placeholder: '25.00', required: true });
  const label = h('input', { type: 'text', placeholder: 'Birthday card from Mom' });
  const last4 = h('input', { type: 'text', inputMode: 'numeric', maxLength: 4 });
  const note = h('input', { type: 'text', placeholder: 'In the desk drawer' });
  const number = h('input', { type: 'text', autocomplete: 'off' });
  const pin = h('input', { type: 'text', autocomplete: 'off' });
  const message = h('p', { class: 'error', role: 'alert', hidden: true });
  const fail = (text) => { message.textContent = text; message.hidden = false; };
  const canStore = data.settings.storageMode !== 'none';

  const submit = (e) => {
    e.preventDefault();
    const balanceCents = parseDollars(balance.value);
    if (balanceCents === null) return fail(errorText('invalid-amount'));
    const hasCode = number.value.trim() || pin.value.trim();
    if (hasCode && data.locked) return fail(errorText('locked'));

    let domains;
    let custom = null;
    let merchantId = store.value;
    if (store.value === '__other') {
      domains = parseDomains(customSites.value);
      if (!domains || !customName.value.trim()) return fail(errorText('invalid-domain'));
      if (conflictingMerchant(data.merchants, domains, `custom:${domains[0]}`)) return fail(errorText('site-in-use'));
      custom = { name: customName.value, domains };
      merchantId = '';
    } else {
      domains = data.merchants.find((m) => m.id === store.value)?.domains;
      if (!domains) return fail(errorText('merchant-required'));
    }

    view.adding = false;
    const card = { merchantId, label: label.value, last4: last4.value, note: note.value, balanceCents, code: { number: number.value, pin: pin.value } };
    act(() => send('cards/add', { card, custom }));
  };

  return h('form', { onsubmit: submit },
    h('h2', {}, 'Add a gift card'),
    h('label', { class: 'field' }, h('span', {}, 'Store'), store),
    customFields,
    h('div', { class: 'two' },
      h('label', { class: 'field' }, h('span', {}, 'Balance'), balance),
      h('label', { class: 'field' }, h('span', {}, 'Last 4 digits'), last4)),
    h('label', { class: 'field' }, h('span', {}, 'Nickname (optional)'), label),
    canStore && h('div', { class: 'two' },
      h('label', { class: 'field' }, h('span', {}, 'Card number'), number),
      h('label', { class: 'field' }, h('span', {}, 'PIN'), pin)),
    h('label', { class: 'field' }, h('span', {}, 'Where you keep it (optional)'), note),
    message,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn' }, 'Add card'),
      h('button', { class: 'quiet', type: 'button', onclick: () => { view.adding = false; render(); } }, 'Cancel')));
}

function activity() {
  if (!data.activity.length) return [];
  return [h('h2', {}, 'Taken from your balances'), h('div', { class: 'activity' }, data.activity.map((e) =>
    h('div', {},
      h('span', { class: e.undone ? 'undone' : '' }, `${formatCents(e.cents)} from ${e.cardName}, ${timeAgo(e.at)}`),
      !e.undone && h('button', { class: 'quiet', onclick: () => act(() => send('ledger/undo', { entryId: e.id })) }, 'Undo'))))];
}

function render() {
  const total = data.cards.reduce((sum, c) => sum + c.balanceCents, 0);
  const count = data.cards.length;
  app.replaceChildren(
    h('header', { class: 'top' },
      h('div', {},
        h('h1', { class: 'total money' }, formatCents(total)),
        h('div', { class: 'total-note' }, count === 1 ? 'on 1 gift card' : `across ${count} gift cards`)),
      h('button', { class: 'quiet', onclick: () => chrome.runtime.openOptionsPage() }, 'Settings')),
    ...banners(),
    ...(view.adding ? [addForm()] : [
      ...notices().flat(),
      count
        ? h('section', { class: 'list' }, data.cards.map(cardRow))
        : h('div', { class: 'empty' }, 'Add a gift card and you\'ll be reminded of it on that store\'s website.'),
      h('div', { class: 'add' }, h('button', { class: 'btn', onclick: () => { view.adding = true; render(); } }, 'Add a gift card')),
      ...activity(),
    ]),
  );
  document.querySelectorAll('.scratch').forEach((panel) => {
    if (view.revealed.has(panel.dataset.scratch) && !panel.classList.contains('open')) {
      requestAnimationFrame(() => panel.classList.add('open'));
    }
  });
}

refresh();
