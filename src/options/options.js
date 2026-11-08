import { errorText, h, send, timeAgo } from '../popup/ui.js';
import { originPatterns } from '../lib/match.js';

const app = document.getElementById('app');
const notes = { storage: null, gmail: null, transfer: null };
let data = null;

async function refresh() {
  data = await send('app/state');
  render();
}

async function act(slot, fn, successText) {
  notes[slot] = null;
  try {
    const result = await fn();
    const text = typeof successText === 'function' ? successText(result) : successText;
    if (text) notes[slot] = { ok: true, text };
  } catch (error) {
    notes[slot] = { ok: false, text: errorText(error.code) };
  }
  await refresh();
}

function note(slot) {
  const item = notes[slot];
  if (!item) return null;
  return h('p', { class: item.ok ? 'ok' : 'error', role: 'status' }, item.text);
}

function storageSection() {
  const current = data.settings.storageMode;
  const options = [
    ['local', 'Save on this computer', 'Fastest at checkout. Anyone with access to your Chrome profile could read the numbers.'],
    ['encrypted', 'Save with a passphrase', 'You enter it once each time Chrome starts. If you forget it, the numbers are lost, but your cards and balances stay.'],
    ['none', 'Don\'t save numbers', 'Keeps only the store, balance and last 4 digits. Switching to this erases any saved numbers.'],
  ];
  const radios = options.map(([value, title, detail]) =>
    h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'mode', value, checked: value === current }),
      h('strong', {}, title),
      h('small', {}, detail)));
  const pass = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirmPass = h('input', { type: 'password', autocomplete: 'new-password' });
  const passFields = h('div', { hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Passphrase (at least 8 characters)'), pass),
    h('label', { class: 'field' }, h('span', {}, 'Repeat passphrase'), confirmPass));
  const selected = () => radios.map((r) => r.querySelector('input')).find((i) => i.checked).value;
  const needsPass = () => selected() === 'encrypted' && current !== 'encrypted';
  radios.forEach((r) => r.addEventListener('change', () => { passFields.hidden = !needsPass(); }));

  const save = () => {
    const mode = selected();
    if (needsPass() && pass.value !== confirmPass.value) {
      notes.storage = { ok: false, text: 'Those passphrases don\'t match.' };
      render();
      return;
    }
    const hasCodes = data.cards.some((c) => c.hasCode);
    if (mode === 'none' && current !== 'none' && hasCodes && !window.confirm('Erase all saved card numbers and PINs? This can\'t be undone.')) return;
    act('storage', () => send('settings/setMode', { mode, passphrase: pass.value }), 'Saved.');
  };

  return h('section', {},
    h('h2', {}, 'Card numbers and PINs'),
    h('p', {}, 'They never leave this computer. Store names and balances are always saved, so reminders keep working.'),
    radios,
    passFields,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: save }, 'Save storage choice'),
      current === 'encrypted' && !data.locked && h('button', { class: 'quiet', onclick: () => act('storage', () => send('vault/lock')) }, 'Lock now')),
    note('storage'));
}

function gmailSection() {
  const { configured, enabled, needsReconnect, lastScanAt, lastError } = data.gmail;
  let status;
  if (!configured) status = 'Gmail needs a one-time Google setup. Follow docs/SETUP.md in the project folder, then reload the extension.';
  else if (needsReconnect) status = 'Google access expired. Reconnect to keep scanning.';
  else if (!enabled) status = 'Not connected.';
  else if (lastError) status = errorText(lastError);
  else status = lastScanAt ? `Connected. Last checked ${timeAgo(lastScanAt)}.` : 'Connected.';

  const connect = () => act('gmail', () => send('gmail/connect'), 'Gmail connected.');
  return h('section', {},
    h('h2', {}, 'Gmail receipts'),
    h('p', {}, 'Reads order emails from the stores you have cards for, about once an hour. Email stays between Chrome and Google. Only the Gmail account signed in to this Chrome profile is scanned.'),
    h('p', { class: 'status' }, status),
    configured && h('div', { class: 'row' },
      (!enabled || needsReconnect) && h('button', { class: 'btn', onclick: connect }, needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail'),
      enabled && !needsReconnect && h('button', { class: 'btn', onclick: () => act('gmail', () => send('gmail/scan'), 'Scan finished.') }, 'Scan now'),
      enabled && h('button', { class: 'quiet danger', onclick: () => act('gmail', () => send('gmail/disconnect'), 'Gmail disconnected.') }, 'Disconnect Gmail')),
    note('gmail'));
}

function siteSection() {
  const missing = new Map();
  for (const card of data.cards) {
    if (!card.siteAccess) missing.set(card.merchantId, card);
  }
  if (!missing.size) return null;
  const cards = [...missing.values()];
  const allow = () => {
    chrome.permissions.request({ origins: cards.flatMap((c) => originPatterns(c.domains)) }).then(refresh, refresh);
  };
  return h('section', {},
    h('h2', {}, 'Reminders that are off'),
    h('p', {}, `Chrome hasn't allowed reminders on: ${cards.map((c) => c.merchantName).join(', ')}.`),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: allow }, 'Turn on reminders')));
}

function transferSection() {
  const include = h('input', { type: 'checkbox' });
  const exportPass = h('input', { type: 'password', autocomplete: 'new-password' });
  const passField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Passphrase for this file (at least 8 characters)'), exportPass);
  include.addEventListener('change', () => { passField.hidden = !include.checked; });

  const exportFile = () => act('transfer', async () => {
    const json = await send('transfer/export', { includeCodes: include.checked, passphrase: exportPass.value });
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    h('a', { href: url, download: 'gift-cards.json' }).click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'Exported to gift-cards.json.');

  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const importPass = h('input', { type: 'password', autocomplete: 'off' });
  const importFile = () => act('transfer', async () => {
    if (!file.files[0]) throw Object.assign(new Error(), { code: 'bad-file' });
    return send('transfer/import', { json: await file.files[0].text(), passphrase: importPass.value });
  }, (r) => `Imported ${r.added}, skipped ${r.skipped}.`);

  return h('section', {},
    h('h2', {}, 'Share cards'),
    h('p', {}, 'Export a file to hand cards to someone else. Balances don\'t stay in step after that, so remove the card from one side.'),
    h('label', { class: 'check' }, include, 'Include card numbers and PINs, encrypted'),
    passField,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: exportFile }, 'Export cards')),
    h('label', { class: 'field' }, h('span', {}, 'File to import'), file),
    h('label', { class: 'field' }, h('span', {}, 'File passphrase, if it has one'), importPass),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: importFile }, 'Import cards')),
    note('transfer'));
}

function render() {
  const firstRun = !data.settings.setupDone;
  app.replaceChildren(
    h('h1', {}, firstRun ? 'Set up your gift cards' : 'Gift card settings'),
    ...[
      firstRun && h('p', { class: 'intro' }, 'Choose how to store card numbers below. You can change this later.'),
      storageSection(),
      gmailSection(),
      siteSection(),
      transferSection(),
    ].filter(Boolean),
  );
}

refresh();
