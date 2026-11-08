// Turns an order email into structured amounts. Pure text handling, so it can
// run in a service worker (no DOMParser there) and be tested with plain strings.
// When unsure it answers "ignore": a missed email costs less than a wrong
// subtraction from someone's balance.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', dollar: '$', minus: '−', ndash: '–', mdash: '—', ensp: ' ', emsp: ' ', thinsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function stripHtml(html) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|li|table|h[1-6])\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text);
}

function toLines(text) {
  return text
    .slice(0, 200_000)
    .replace(/[ ​-‍﻿]/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const DASH = '[-–—−]';
const MONEY = new RegExp(`(${DASH}?)(\\s*)(\\()?\\s*(?:US)?\\$\\s*(${DASH}?)\\s*(\\d[\\d,]*)(?:\\.(\\d{2}))?(\\))?`, 'g');
const LONE_MONEY = new RegExp(`^[-–—−(\\s]*(?:US)?\\$\\s*${DASH}?\\s*\\d[\\d,]*(?:\\.\\d{2})?\\)?$`);
const COLON_DASH = new RegExp(`:\\s*${DASH}\\s+\\$`);

function findMoney(line) {
  return [...line.matchAll(MONEY)].map((m) => ({
    cents: Number(m[5].replace(/,/g, '')) * 100 + Number(m[6] ?? 0),
    // "Gift Card - $25" is a name and a price, while "-$25" is a deduction.
    negative: (m[1] && !m[2]) || m[4] || (m[3] && m[7]) || COLON_DASH.test(line) ? true : false,
  }));
}

function amountFor(lines, i) {
  const own = findMoney(lines[i]);
  if (own.length) return own[own.length - 1];
  const next = lines[i + 1];
  return next && LONE_MONEY.test(next) ? findMoney(next)[0] : null;
}

const GIFT_CARD = /gift\s*-?\s*(?:card|certificate)s?|e-?gift/i;
const NOT_A_PAYMENT = /\b(buy|send|give|get|earn|reward|bonus|terms|check|can be|may|cannot|not be|learn|shop|promo|offer|off|eligible|expires?)\b/i;
const BALANCE_NOTE = /\b(remaining|available|left|balance)\b/i;
const SPENT_WORD = /\b(applied|redeemed|used)\b/i;
const PAYMENT_WORD = /\b(applied|redeemed|used|payment|paid|tender(ed)?|charged to|ending)\b|[x*]{2,}\s*\d{4}/i;
const PAYMENT_HEADER = /^(payment( method| information| info| details| summary)?|paid with|billing summary)\b.{0,20}$/i;
const LAST4 = /(?:ending(?:\s+in)?|[x*•]{2,}|#)\s*(\d{4})\b/i;

function inPaymentSection(lines, i) {
  for (let j = Math.max(0, i - 6); j < i; j += 1) {
    if (PAYMENT_HEADER.test(lines[j])) return true;
  }
  return false;
}

function findGiftCardPayments(lines) {
  const found = [];
  lines.forEach((line, i) => {
    if (!GIFT_CARD.test(line) || NOT_A_PAYMENT.test(line)) return;
    const amount = amountFor(lines, i);
    if (!amount || amount.cents === 0) return;
    if (BALANCE_NOTE.test(line) && !amount.negative && !SPENT_WORD.test(line)) return;
    if (!amount.negative && !PAYMENT_WORD.test(line) && !inPaymentSection(lines, i)) return;
    found.push({ cents: amount.cents, last4: line.match(LAST4)?.[1] ?? '' });
  });
  return collapseRepeats(found);
}

// Receipts often repeat the same payment in a summary and a details section.
function collapseRepeats(payments) {
  const withLast4 = [];
  for (const p of payments) {
    if (p.last4 && !withLast4.some((q) => q.last4 === p.last4 && q.cents === p.cents)) withLast4.push(p);
  }
  const without = [];
  for (const p of payments) {
    if (!p.last4 && !withLast4.some((q) => q.cents === p.cents) && !without.some((q) => q.cents === p.cents)) {
      without.push(p);
    }
  }
  return [...withLast4, ...without];
}

const TOTAL_PATTERNS = [
  /\b(order|grand)\s+total\b/i,
  /\btotal\s+(charged|paid|amount|for this order)\b/i,
  /\bamount\s+(charged|paid|due)\b/i,
  /\btotal\b/i,
];
const NOT_TOTAL = /sub-?\s*total|total\s+(savings|saved|items?|before|discount|tax|weight|points|rewards)/i;

function findTotal(lines) {
  for (const pattern of TOTAL_PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!pattern.test(lines[i]) || NOT_TOTAL.test(lines[i])) continue;
      const amount = amountFor(lines, i);
      if (amount && amount.cents > 0 && !amount.negative) return amount.cents;
    }
  }
  return 0;
}

const ORDER_NUMBER = /\border\s*(?:number|num|no\.?|id|#)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{4,})/gi;

function findOrderNumber(subject, lines) {
  for (const source of [subject, ...lines.slice(0, 80)]) {
    for (const m of source.matchAll(ORDER_NUMBER)) {
      if (/\d/.test(m[1])) return m[1].toUpperCase();
    }
  }
  return null;
}

const IGNORE_SUBJECT = /\b(shipped|shipping|delivered|delivery update|out for delivery|on (?:its|the) way|tracking|refund(?:ed)?|return(?:ed)?|cancel(?:l?ed|lation)?|survey|review|sale|deals?|save|offers?|coupon|reminder|statement|gift\s*-?\s*cards?|e-?gift)\b|\d+%\s*off/i;
const PURCHASE_MARKER = /\b(order|receipt|confirmation|purchase|invoice|thanks for|thank you for)\b/i;

export function bodyToText({ plain, html }) {
  if (plain && plain.includes('$')) return plain;
  return html ? stripHtml(html) : (plain ?? '');
}

export function parseReceipt({ subject = '', text = '' }) {
  if (IGNORE_SUBJECT.test(subject)) return { kind: 'ignore', reason: 'subject' };
  const lines = toLines(text);
  const giftCards = findGiftCardPayments(lines);
  const totalCents = findTotal(lines);
  if (!giftCards.length && !totalCents) return { kind: 'ignore', reason: 'no-amounts' };
  const opening = `${subject} ${lines.slice(0, 30).join(' ')}`;
  if (!PURCHASE_MARKER.test(opening)) return { kind: 'ignore', reason: 'not-a-purchase' };
  return { kind: 'purchase', orderNumber: findOrderNumber(subject, lines), totalCents, giftCards };
}
