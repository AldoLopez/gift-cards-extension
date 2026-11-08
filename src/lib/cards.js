// Cards and their ledger. Money is always integer cents. A card's balance is
// the sum of its ledger entries, which is what makes subtractions undoable.
// These functions change the state object they're given and touch no browser APIs.

export class AppError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseDollars(value) {
  const text = String(value ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

export function formatCents(cents) {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

export function balanceOf(state, cardId) {
  return state.ledger.reduce(
    (sum, entry) => (entry.cardId === cardId && !entry.undoneAt ? sum + entry.delta : sum),
    0,
  );
}

function addEntry(state, fields) {
  const entry = { id: crypto.randomUUID(), ...fields };
  state.ledger.push(entry);
  return entry;
}

export function cleanLast4(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.slice(-4);
}

export function createCard(state, input, now) {
  if (!input.merchantId) throw new AppError('merchant-required');
  if (!Number.isInteger(input.balanceCents) || input.balanceCents < 0) throw new AppError('invalid-amount');
  const card = {
    id: crypto.randomUUID(),
    merchantId: input.merchantId,
    label: String(input.label ?? '').trim().slice(0, 60),
    last4: cleanLast4(input.last4),
    note: String(input.note ?? '').trim().slice(0, 200),
    addedAt: now,
    balanceConfirmedAt: now,
  };
  if (input.code) card.code = input.code;
  state.cards.push(card);
  if (input.balanceCents > 0) {
    addEntry(state, { cardId: card.id, delta: input.balanceCents, source: 'manual', at: now });
  }
  return card;
}

export function requireCard(state, cardId) {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) throw new AppError('card-not-found');
  return card;
}

export function setBalance(state, cardId, cents, now) {
  if (!Number.isInteger(cents) || cents < 0) throw new AppError('invalid-amount');
  const card = requireCard(state, cardId);
  const delta = cents - balanceOf(state, cardId);
  if (delta !== 0) addEntry(state, { cardId, delta, source: 'manual', at: now });
  card.balanceConfirmedAt = now;
}

// Never takes a balance below zero. `shortCents` is the part that didn't fit,
// which means the stored balance was wrong and someone should look at it.
export function applySpend(state, cardId, cents, { orderKey, subject, now }) {
  requireCard(state, cardId);
  const balance = balanceOf(state, cardId);
  const applied = Math.min(cents, balance);
  const entry =
    applied > 0
      ? addEntry(state, { cardId, delta: -applied, source: 'email', orderKey, subject, at: now })
      : null;
  return { entry, appliedCents: applied, shortCents: cents - applied };
}

export function undoEntry(state, entryId, now) {
  const entry = state.ledger.find((e) => e.id === entryId);
  if (!entry || entry.source !== 'email' || entry.undoneAt) throw new AppError('entry-not-found');
  entry.undoneAt = now;
}

export function deleteCard(state, cardId) {
  state.cards = state.cards.filter((c) => c.id !== cardId);
  state.ledger = state.ledger.filter((e) => e.cardId !== cardId);
  state.scan.reviews = state.scan.reviews
    .map((r) => ({ ...r, candidates: r.candidates.filter((id) => id !== cardId) }))
    .filter((r) => r.candidates.length > 0);
}
