// Export and import of cards between people. Codes only travel encrypted with
// a passphrase chosen for that export, whatever the local storage mode is.

import { AppError, balanceOf, cleanLast4, createCard } from './cards.js';
import { decodeCode, encodeCode, deriveKey, encryptText, decryptText, fromBase64, toBase64 } from './vault.js';
import { normalizeDomain } from './match.js';

const FORMAT = 'gift-card-wallet';
const ITERATIONS = 600_000;

export async function buildExport(state, merchants, options, now, iterations = ITERATIONS) {
  const { includeCodes, passphrase, sessionKey } = options;
  const out = { format: FORMAT, version: 1, exportedAt: now, cards: [] };
  let exportKey = null;
  if (includeCodes) {
    if (String(passphrase ?? '').length < 8) throw new AppError('passphrase-too-short');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    exportKey = await deriveKey(passphrase, salt, iterations);
    out.kdf = { salt: toBase64(salt), iterations };
  }
  for (const card of state.cards) {
    const m = merchants.find((x) => x.id === card.merchantId);
    if (!m) continue;
    const item = {
      merchant: { id: m.id, name: m.name, domains: m.domains, emailDomains: m.emailDomains, balanceUrl: m.balanceUrl },
      label: card.label,
      last4: card.last4,
      note: card.note,
      balanceCents: balanceOf(state, card.id),
    };
    if (includeCodes && card.code) {
      const code = await decodeCode(card.code, sessionKey);
      item.code = await encryptText(exportKey, JSON.stringify(code));
    }
    out.cards.push(item);
  }
  return out;
}

function validMerchant(raw) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  const domains = Array.isArray(raw.domains) ? raw.domains.map(normalizeDomain).filter(Boolean) : [];
  const emailDomains = Array.isArray(raw.emailDomains) ? raw.emailDomains.map(normalizeDomain).filter(Boolean) : [];
  if (!domains.length) return null;
  return {
    id: raw.id.slice(0, 120),
    name: raw.name.slice(0, 60),
    domains,
    emailDomains: emailDomains.length ? emailDomains : domains,
    balanceUrl: typeof raw.balanceUrl === 'string' && raw.balanceUrl.startsWith('https://') ? raw.balanceUrl : null,
  };
}

function isDuplicate(state, merchantId, last4, label) {
  return state.cards.some(
    (c) => c.merchantId === merchantId && c.last4 === last4 && (last4 !== '' || c.label === label),
  );
}

// Cards get addedAt = now, so the importer's older emails aren't treated as
// purchases the card could have covered.
export async function applyImport(state, merchants, file, options, now) {
  if (file?.format !== FORMAT || file.version !== 1 || !Array.isArray(file.cards)) throw new AppError('bad-file');
  const { passphrase, sessionKey } = options;
  const mode = state.settings.storageMode;
  const hasCodes = file.cards.some((c) => c.code);

  let exportKey = null;
  if (hasCodes && mode !== 'none') {
    if (!passphrase) throw new AppError('passphrase-required');
    const iterations = file.kdf?.iterations;
    if (typeof file.kdf?.salt !== 'string' || !Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) {
      throw new AppError('bad-file');
    }
    exportKey =await deriveKey(passphrase, fromBase64(file.kdf.salt), file.kdf.iterations);
  }

  let added = 0;
  let skipped = 0;
  for (const raw of file.cards) {
    const parsed = validMerchant(raw.merchant);
    const balanceCents = raw.balanceCents;
    if (!parsed || !Number.isInteger(balanceCents) || balanceCents < 0) {
      skipped += 1;
      continue;
    }
    const last4 = cleanLast4(raw.last4);
    const label = String(raw.label ?? '').trim().slice(0, 60);
    let merchant = merchants.find((m) => m.id === parsed.id);
    if (!merchant) {
      merchant = parsed;
      state.customMerchants.push(merchant);
      merchants.push(merchant);
    }
    if (isDuplicate(state, merchant.id, last4, label)) {
      skipped += 1;
      continue;
    }
    let code;
    if (raw.code && mode !== 'none') {
      let plain;
      try {
        plain = JSON.parse(await decryptText(exportKey, raw.code));
      } catch {
        throw new AppError('wrong-passphrase');
      }
      code = await encodeCode(mode, plain, sessionKey);
    }
    createCard(state, { merchantId: merchant.id, label, last4, note: raw.note, balanceCents, code }, now);
    added += 1;
  }
  return { added, skipped };
}
