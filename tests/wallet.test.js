import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySpend, balanceOf, createCard, deleteCard, formatCents, parseDollars, setBalance, undoEntry } from '../src/lib/cards.js';
import { allMerchants, cardsHereFirst, isCheckoutPage, siteDefault, conflictingMerchant, customMerchant, findMerchantByEmailDomain, findMerchantByHost, hostMatches, normalizeDomain, originPatterns, parseDomains } from '../src/lib/match.js';
import { createVault, decodeCode, encodeCode, openVault } from '../src/lib/vault.js';
import { applyImport, buildExport } from '../src/lib/transfer.js';
import { buildQuery, decodeBody, extractMessage, senderDomain } from '../src/lib/gmail.js';
import { processMessage, pruneProcessed } from '../src/lib/scanner.js';
import { emptyState } from '../src/lib/store.js';

const FAST = 1000; // PBKDF2 iterations for tests only.
const target = { id: 'target', name: 'Target', domains: ['target.com'], emailDomains: ['target.com'], balanceUrl: null };
const addCard = (state, overrides = {}) =>
  createCard(state, { merchantId: 'target', balanceCents: 5000, ...overrides }, overrides.now ?? 1000);
const message = (body, overrides = {}) => ({ id: 'm1', subject: 'Your order confirmation', internalDate: 5000, text: body, ...overrides });
const GC_RECEIPT = 'Order #A12345\nGift card applied -$20.00\nOrder total $20.00';

describe('money', () => {
  it('parses dollars to cents exactly', () => {
    expect(parseDollars('19.99')).toBe(1999);
    expect(parseDollars('$1,000.5')).toBe(100050);
    expect(parseDollars('abc')).toBeNull();
    expect(parseDollars('1.234')).toBeNull();
  });

  it('formats cents', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(5)).toBe('$0.05');
  });
});

describe('ledger', () => {
  it('derives balance from entries and undoes a spend', () => {
    const state = emptyState();
    const card = addCard(state);
    const { entry } = applySpend(state, card.id, 1500, { orderKey: 'k', subject: 's', now: 2 });
    expect(balanceOf(state, card.id)).toBe(3500);
    undoEntry(state, entry.id, 3);
    expect(balanceOf(state, card.id)).toBe(5000);
    expect(() => undoEntry(state, entry.id, 4)).toThrow();
  });

  it('never goes below zero and reports the shortfall', () => {
    const state = emptyState();
    const card = addCard(state, { balanceCents: 1000 });
    const result = applySpend(state, card.id, 1500, { orderKey: 'k', subject: 's', now: 2 });
    expect(result).toMatchObject({ appliedCents: 1000, shortCents: 500 });
    expect(balanceOf(state, card.id)).toBe(0);
  });

  it('sets a balance and records when it was confirmed', () => {
    const state = emptyState();
    const card = addCard(state);
    setBalance(state, card.id, 1234, 99);
    expect(balanceOf(state, card.id)).toBe(1234);
    expect(card.balanceConfirmedAt).toBe(99);
  });

  it('removes ledger entries and review candidates with the card', () => {
    const state = emptyState();
    const a = addCard(state);
    state.scan.reviews.push({ id: 'r', kind: 'overdraw', candidates: [a.id] });
    deleteCard(state, a.id);
    expect(state.ledger).toEqual([]);
    expect(state.scan.reviews).toEqual([]);
  });
});

describe('merchant matching', () => {
  it('matches domains and subdomains only', () => {
    expect(hostMatches('www.target.com', 'target.com')).toBe(true);
    expect(hostMatches('target.com', 'target.com')).toBe(true);
    expect(hostMatches('nottarget.com', 'target.com')).toBe(false);
    expect(hostMatches('target.com.evil.net', 'target.com')).toBe(false);
  });

  it('finds merchants by host and email domain', () => {
    expect(findMerchantByHost([target], 'shop.target.com')).toBe(target);
    expect(findMerchantByEmailDomain([target], 'oe.target.com')).toBe(target);
    expect(findMerchantByEmailDomain([target], 'target.com.phish.io')).toBeNull();
  });

  it('normalizes typed websites and rejects junk', () => {
    expect(normalizeDomain('https://www.Example.com/gifts?x=1')).toBe('example.com');
    expect(normalizeDomain('nodots')).toBeNull();
    expect(customMerchant('', 'example.com')).toBeNull();
    expect(originPatterns(['a.com'])).toEqual(['*://*.a.com/*']);
  });
});

describe('stores with several websites', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/merchants.json', import.meta.url), 'utf8'));

  it('has all-site access up front, so saving a card never waits on a prompt', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.host_permissions).toContain('*://*/*');
    const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
    expect(popup.match(/requestSites\(/g)).toHaveLength(2); // the definition and "Turn on reminders"
  });

  it.each([
    ['www.barnesandnoble.com', '/cart/'],
    ['www.barnesandnoble.com', '/checkout/'],
    ['secure-oldnavy.gap.com', '/shopping-bag'],
    ['www.sephora.com', '/basket'],
    ['shop.lululemon.com', '/shop/cart'],
    ['www.cvs.com', '/shop/cart'],
    ['www.amazon.com', '/gp/buy/spc/handlers/display.html'],
    ['www.amazon.com', '/gp/cart/view.html'],
    ['www.example.com', '/shop#/checkout/payment'],
    ['www.example.com', '/checkout-step-2'],
    ['www.example.com', '/ShoppingCart.aspx'],
    ['checkout.example.com', '/'],
  ])('treats %s%s as a cart or checkout page', (host, path) => {
    expect(isCheckoutPage(host, path)).toBe(true);
  });

  it.each([
    ['www.example.com', '/'],
    ['www.example.com', '/p/cart-organizer/123'],
    ['www.example.com', '/shop/handbag'],
    ['www.example.com', '/shop/bags'],
    ['www.example.com', '/gift-card-balance'],
    ['www.example.com', undefined],
  ])('does not treat %s%s as a cart or checkout page', (host, path) => {
    expect(isCheckoutPage(host, path)).toBe(false);
  });

  it('starts the add form on the site being viewed', () => {
    expect(siteDefault(catalog, 'oldnavy.gap.com')).toEqual({ merchantId: 'gap' });
    expect(siteDefault(catalog, 'www.new-store.com')).toEqual({ domain: 'new-store.com' });
    expect(siteDefault(catalog, 'localhost')).toBeNull();
    expect(siteDefault(catalog, '')).toBeNull();
  });

  it('lists cards for the current store first and keeps the rest in order', () => {
    const cards = [{ id: 1, merchantId: 'a' }, { id: 2, merchantId: 'b' }, { id: 3, merchantId: 'c' }, { id: 4, merchantId: 'b' }];
    expect(cardsHereFirst(cards, 'b').map((c) => c.id)).toEqual([2, 4, 1, 3]);
    expect(cardsHereFirst(cards, undefined)).toBe(cards);
  });

  it('parses a typed list and rejects a bad entry', () => {
    expect(parseDomains('https://www.a.com/x, b.com;c.com a.com')).toEqual(['a.com', 'b.com', 'c.com']);
    expect(parseDomains('a.com, nope')).toBeNull();
    expect(parseDomains('')).toBeNull();
  });

  it('creates a custom store with several websites', () => {
    expect(customMerchant('Shop', 'a.com, b.com')).toMatchObject({ id: 'custom:a.com', domains: ['a.com', 'b.com'] });
  });

  it('merges added websites without changing the original store', () => {
    const merged = allMerchants([target], [], { target: ['target-outlet.com'] });
    expect(findMerchantByHost(merged, 'shop.target-outlet.com').id).toBe('target');
    expect(target.domains).toEqual(['target.com']);
  });

  it('spots a website another store already has, but not its own', () => {
    expect(conflictingMerchant([target], ['target.com'], 'other')).toBe(target);
    expect(conflictingMerchant([target], ['shop.target.com'], 'other')).toBe(target);
    expect(conflictingMerchant([target], ['target.com'], 'target')).toBeNull();
    expect(conflictingMerchant([target], ['nottarget.com'], 'other')).toBeNull();
  });

  it('matches one Gap card on all of its brands', () => {
    for (const host of ['www.gap.com', 'oldnavy.gap.com', 'bananarepublic.gap.com', 'athleta.gap.com', 'www.oldnavy.com']) {
      expect(findMerchantByHost(catalog, host).id).toBe('gap');
    }
    expect(findMerchantByHost(catalog, 'www.cb2.com').id).toBe('crateandbarrel');
    expect(findMerchantByHost(catalog, 'shop.lululemon.com').id).toBe('lululemon');
  });

  it('keeps every built-in website unique and valid', () => {
    for (const m of catalog) {
      expect(parseDomains(m.domains)).toEqual(m.domains);
      expect(conflictingMerchant(catalog, m.domains, m.id)).toBeNull();
    }
  });

  it('carries added websites through import without touching other stores', async () => {
    const file = { format: 'gift-card-wallet', version: 1, cards: [{ merchant: { id: 'target', name: 'Target', domains: ['target.com', 'target-outlet.com', 'other.com'] }, last4: '1234', balanceCents: 100 }] };
    const other = { id: 'other', name: 'Other', domains: ['other.com'], emailDomains: ['other.com'], balanceUrl: null };
    const dest = emptyState();
    await applyImport(dest, [target, other], file, {}, 2);
    expect(dest.extraDomains.target).toEqual(['target-outlet.com']);
  });
});

describe('Gmail helpers', () => {
  it('builds a query limited to known senders', () => {
    const q = buildQuery(['a.com', 'b.com', 'a.com'], 10_000);
    expect(q).toContain('from:(a.com OR b.com)');
    expect(q).toContain('after:10');
  });

  it('takes the sender domain from the address, not the display name', () => {
    expect(senderDomain('"target.com" <spam@phish.io>')).toBe('phish.io');
    expect(senderDomain('Orders <orders@oe.target.com>')).toBe('oe.target.com');
  });

  it('decodes base64url UTF-8', () => {
    expect(decodeBody(Buffer.from('café $5').toString('base64url'))).toBe('café $5');
  });

  it('pulls bodies out of nested parts and skips attachments', () => {
    const encode = (s) => Buffer.from(s).toString('base64url');
    const m = extractMessage({
      id: 'x',
      internalDate: '42',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'Receipt' }, { name: 'From', value: 'a@b.com' }],
        parts: [
          { mimeType: 'text/plain', filename: 'a.txt', body: { data: encode('attachment') } },
          { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', filename: '', body: { data: encode('<p>hi</p>') } }] },
        ],
      },
    });
    expect(m).toMatchObject({ id: 'x', internalDate: 42, subject: 'Receipt', senderDomain: 'b.com' });
    expect(m.bodies).toEqual({ html: '<p>hi</p>' });
  });
});

describe('scanning', () => {
  it('subtracts from the only card', () => {
    const state = emptyState();
    const card = addCard(state);
    const events = processMessage(state, target, message(GC_RECEIPT), 9000);
    expect(events.map((e) => e.type)).toEqual(['spent']);
    expect(balanceOf(state, card.id)).toBe(3000);
  });

  it('does not subtract twice for the same order', () => {
    const state = emptyState();
    const card = addCard(state);
    processMessage(state, target, message(GC_RECEIPT), 9000);
    processMessage(state, target, message(GC_RECEIPT, { id: 'm2', subject: 'Your receipt' }), 9001);
    expect(balanceOf(state, card.id)).toBe(3000);
  });

  it('asks which card when it cannot tell', () => {
    const state = emptyState();
    const a = addCard(state, { last4: '1111' });
    const b = addCard(state, { last4: '2222' });
    const events = processMessage(state, target, message(GC_RECEIPT), 9000);
    expect(events.map((e) => e.type)).toEqual(['review']);
    expect(state.scan.reviews[0].candidates).toEqual([a.id, b.id]);
    expect(balanceOf(state, a.id)).toBe(5000);
  });

  it('uses the last 4 digits to pick a card', () => {
    const state = emptyState();
    const a = addCard(state, { last4: '1111' });
    const b = addCard(state, { last4: '2222' });
    processMessage(state, target, message('Order #A12345\nGift card ending 2222 -$20.00\nOrder total $20.00'), 9000);
    expect(balanceOf(state, a.id)).toBe(5000);
    expect(balanceOf(state, b.id)).toBe(3000);
  });

  it('leaves balances alone when a different card was used', () => {
    const state = emptyState();
    const a = addCard(state, { last4: '1111' });
    const events = processMessage(state, target, message('Order #A12345\nGift card ending 9999 -$20.00\nOrder total $20.00'), 9000);
    expect(events).toEqual([]);
    expect(balanceOf(state, a.id)).toBe(5000);
  });

  it('flags a payment larger than the balance', () => {
    const state = emptyState();
    const card = addCard(state, { balanceCents: 500 });
    const events = processMessage(state, target, message(GC_RECEIPT), 9000);
    expect(events.map((e) => e.type)).toEqual(['spent', 'review']);
    expect(balanceOf(state, card.id)).toBe(0);
    expect(state.scan.reviews[0]).toMatchObject({ kind: 'overdraw', shortCents: 1500 });
  });

  it('alerts when a card could have been used, capped at the order total', () => {
    const state = emptyState();
    addCard(state);
    processMessage(state, target, message('Order #A12345\nOrder total $30.00'), 9000);
    expect(state.scan.alerts[0]).toMatchObject({ couldUseCents: 3000, totalCents: 3000 });
  });

  it('caps the alert at the balance', () => {
    const state = emptyState();
    addCard(state, { balanceCents: 1000 });
    processMessage(state, target, message('Order #A12345\nOrder total $30.00'), 9000);
    expect(state.scan.alerts[0].couldUseCents).toBe(1000);
  });

  it('ignores purchases from before the card was added', () => {
    const state = emptyState();
    const card = addCard(state, { now: 8000 });
    const events = processMessage(state, target, message(GC_RECEIPT, { internalDate: 5000 }), 9000);
    expect(events).toEqual([]);
    expect(balanceOf(state, card.id)).toBe(5000);
  });

  it('forgets old orders', () => {
    const state = emptyState();
    state.scan.processed = { old: 0, recent: 200 * 86_400_000 };
    pruneProcessed(state, 200 * 86_400_000);
    expect(Object.keys(state.scan.processed)).toEqual(['recent']);
  });
});

describe('code storage', () => {
  it('round-trips through encryption', async () => {
    const { key, meta } = await createVault('correct horse', FAST);
    const field = await encodeCode('encrypted', { number: '1234', pin: '99' }, key);
    expect(JSON.stringify(field)).not.toContain('1234');
    const reopened = await openVault(meta, 'correct horse');
    expect(await decodeCode(field, reopened)).toEqual({ number: '1234', pin: '99' });
  });

  it('rejects a wrong passphrase', async () => {
    const { meta } = await createVault('correct horse', FAST);
    await expect(openVault(meta, 'wrong horse')).rejects.toMatchObject({ code: 'wrong-passphrase' });
  });

  it('rejects a short passphrase', async () => {
    await expect(createVault('short', FAST)).rejects.toMatchObject({ code: 'passphrase-too-short' });
  });

  it('refuses to read or write encrypted codes while locked', async () => {
    const { key } = await createVault('correct horse', FAST);
    const field = await encodeCode('encrypted', { number: '1234' }, key);
    await expect(decodeCode(field, null)).rejects.toMatchObject({ code: 'locked' });
    await expect(encodeCode('encrypted', { number: '1' }, null)).rejects.toMatchObject({ code: 'locked' });
  });

  it('stores nothing in no-codes mode or for blank input', async () => {
    expect(await encodeCode('none', { number: '1234' }, null)).toBeUndefined();
    expect(await encodeCode('local', { number: ' ', pin: '' }, null)).toBeUndefined();
  });
});

describe('export and import', () => {
  const source = () => {
    const state = emptyState();
    addCard(state, { last4: '1111', label: 'Birthday', code: { plain: { number: '5555', pin: '12' } } });
    return state;
  };
  const clone = () => [target];

  it('leaves codes out unless asked', async () => {
    const file = await buildExport(source(), clone(), { includeCodes: false }, 1, FAST);
    expect(JSON.stringify(file)).not.toContain('5555');
    expect(file.cards[0].code).toBeUndefined();
  });

  it('moves a card and encrypted code to another wallet', async () => {
    const file = await buildExport(source(), clone(), { includeCodes: true, passphrase: 'share-pass' }, 1, FAST);
    expect(JSON.stringify(file)).not.toContain('5555');
    const dest = emptyState();
    const result = await applyImport(dest, clone(), JSON.parse(JSON.stringify(file)), { passphrase: 'share-pass' }, 777);
    expect(result).toEqual({ added: 1, skipped: 0 });
    expect(dest.cards[0].addedAt).toBe(777);
    expect(dest.cards[0].code).toEqual({ plain: { number: '5555', pin: '12' } });
    expect(balanceOf(dest, dest.cards[0].id)).toBe(5000);
  });

  it('skips duplicates', async () => {
    const state = source();
    const file = await buildExport(state, clone(), { includeCodes: false }, 1, FAST);
    expect(await applyImport(state, clone(), file, {}, 2)).toEqual({ added: 0, skipped: 1 });
  });

  it('rejects a wrong passphrase and bad files', async () => {
    const file = await buildExport(source(), clone(), { includeCodes: true, passphrase: 'share-pass' }, 1, FAST);
    await expect(applyImport(emptyState(), clone(), file, { passphrase: 'nope-nope' }, 2)).rejects.toMatchObject({ code: 'wrong-passphrase' });
    await expect(applyImport(emptyState(), clone(), { format: 'other' }, {}, 2)).rejects.toMatchObject({ code: 'bad-file' });
  });

  it('drops codes when the importer stores none', async () => {
    const file = await buildExport(source(), clone(), { includeCodes: true, passphrase: 'share-pass' }, 1, FAST);
    const dest = emptyState();
    dest.settings.storageMode = 'none';
    await applyImport(dest, clone(), file, {}, 2);
    expect(dest.cards[0].code).toBeUndefined();
  });

  it('adds unknown merchants and sanitizes their fields', async () => {
    const file = { format: 'gift-card-wallet', version: 1, cards: [{ merchant: { id: 'custom:x.com', name: 'X', domains: ['https://x.com/'], balanceUrl: 'javascript:alert(1)' }, last4: '1', balanceCents: 100 }] };
    const dest = emptyState();
    await applyImport(dest, clone(), file, {}, 2);
    expect(dest.customMerchants[0]).toMatchObject({ domains: ['x.com'], emailDomains: ['x.com'], balanceUrl: null });
  });
});
