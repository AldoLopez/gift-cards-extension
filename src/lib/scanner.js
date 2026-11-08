// Applies parsed receipts to the wallet. processMessage is pure state logic;
// runScan adds Gmail, locking and notifications around it.

import { applySpend, balanceOf, formatCents } from './cards.js';
import { bodyToText, parseReceipt } from './receipt-parser.js';
import { buildQuery, fetchMessages, getToken, isConfigured } from './gmail.js';
import { findMerchantByEmailDomain } from './match.js';
import { loadState, mutate } from './store.js';

const DAY = 86_400_000;
const KEEP_PROCESSED = 180 * DAY;
const MAX_ALERTS = 30;
const MAX_NOTIFICATIONS = 5;

// Picks the card a payment came from, or returns several when it can't tell.
export function candidatesFor(cards, state, last4) {
  if (last4) {
    const exact = cards.filter((c) => c.last4 === last4);
    if (exact.length) return exact;
    return cards.filter((c) => !c.last4);
  }
  if (cards.length <= 1) return cards;
  const funded = cards.filter((c) => balanceOf(state, c.id) > 0);
  return funded.length ? funded : cards;
}

export function processMessage(state, merchant, message, now) {
  const parsed = parseReceipt({ subject: message.subject, text: message.text });
  if (parsed.kind !== 'purchase') return [];

  const orderKey = `${merchant.id}:${parsed.orderNumber ?? `msg:${message.id}`}`;
  if (state.scan.processed[orderKey]) return [];
  state.scan.processed[orderKey] = now;

  const cards = state.cards.filter((c) => c.merchantId === merchant.id && c.addedAt <= message.internalDate);
  if (!cards.length) return [];

  const events = [];
  const common = { merchantId: merchant.id, orderKey, subject: message.subject, at: now };

  for (const payment of parsed.giftCards) {
    const candidates = candidatesFor(cards, state, payment.last4);
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      state.scan.reviews.push({
        id: crypto.randomUUID(),
        kind: 'pick',
        amountCents: payment.cents,
        candidates: candidates.map((c) => c.id),
        ...common,
      });
      events.push({ type: 'review', merchant, cents: payment.cents });
      continue;
    }
    const [card] = candidates;
    const result = applySpend(state, card.id, payment.cents, { orderKey, subject: message.subject, now });
    if (result.appliedCents > 0) events.push({ type: 'spent', merchant, cents: result.appliedCents });
    if (result.shortCents > 0) {
      state.scan.reviews.push({
        id: crypto.randomUUID(),
        kind: 'overdraw',
        amountCents: payment.cents,
        shortCents: result.shortCents,
        candidates: [card.id],
        ...common,
      });
      events.push({ type: 'review', merchant, cents: payment.cents });
    }
  }

  if (!parsed.giftCards.length && parsed.totalCents > 0) {
    const available = cards.reduce((sum, c) => sum + balanceOf(state, c.id), 0);
    if (available > 0) {
      const couldUseCents = Math.min(parsed.totalCents, available);
      state.scan.alerts.push({ id: crypto.randomUUID(), couldUseCents, totalCents: parsed.totalCents, ...common });
      state.scan.alerts = state.scan.alerts.slice(-MAX_ALERTS);
      events.push({ type: 'alert', merchant, cents: couldUseCents });
    }
  }
  return events;
}

export function pruneProcessed(state, now) {
  for (const [key, at] of Object.entries(state.scan.processed)) {
    if (now - at > KEEP_PROCESSED) delete state.scan.processed[key];
  }
}

function notificationFor(event) {
  const amount = formatCents(event.cents);
  const name = event.merchant.name;
  if (event.type === 'spent') return { title: `${amount} spent at ${name}`, message: 'Subtracted from your gift card. Open the extension to undo.' };
  if (event.type === 'alert') return { title: `You could have used a gift card at ${name}`, message: `A recent order could have used ${amount} of your balance.` };
  return { title: `Check a gift card at ${name}`, message: `A ${amount} gift card payment needs your attention.` };
}

export function notify(title, message) {
  return chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title, message });
}

async function markReconnect() {
  const wasFlagged = await mutate((s) => {
    const previous = s.scan.needsReconnect;
    s.scan.needsReconnect = true;
    return previous;
  });
  if (!wasFlagged) notify('Reconnect Gmail', 'Gift card email scanning stopped. Open the extension settings to reconnect.');
}

let running = false;

export async function runScan(merchants) {
  if (running) return { status: 'already-running' };
  running = true;
  const startedAt = Date.now();
  try {
    const before = await loadState();
    if (!before.settings.gmailEnabled || !isConfigured()) return { status: 'off' };

    const merchantIds = new Set(before.cards.map((c) => c.merchantId));
    const active = merchants.filter((m) => merchantIds.has(m.id));
    if (!active.length) return { status: 'no-cards' };

    const earliestCard = Math.min(...before.cards.map((c) => c.addedAt));
    const afterMs = before.scan.lastScanAt ? Math.max(before.scan.lastScanAt - DAY, earliestCard) : earliestCard;

    let messages;
    try {
      const token = await getToken(false);
      messages = await fetchMessages(buildQuery(active.flatMap((m) => m.emailDomains), afterMs), token);
    } catch (error) {
      if (error.code === 'gmail-auth') {
        await markReconnect();
      } else {
        await mutate((s) => { s.scan.lastError = 'gmail-unavailable'; });
      }
      return { status: 'error', error: error.code ?? 'gmail-unavailable' };
    }

    const events = await mutate((s) => {
      const all = [];
      for (const message of messages) {
        const merchant = findMerchantByEmailDomain(active, message.senderDomain);
        // A sender address alone is forgeable, and these emails change balances.
        if (!merchant || /dmarc=fail/i.test(message.authResults)) continue;
        all.push(...processMessage(s, merchant, { ...message, text: bodyToText(message.bodies) }, startedAt));
      }
      s.scan.lastScanAt = startedAt;
      s.scan.lastError = null;
      s.scan.needsReconnect = false;
      pruneProcessed(s, startedAt);
      return all;
    });

    events.slice(0, MAX_NOTIFICATIONS).forEach((e) => {
      const { title, message } = notificationFor(e);
      notify(title, message);
    });
    return { status: 'done', messages: messages.length, events: events.length };
  } finally {
    running = false;
  }
}
