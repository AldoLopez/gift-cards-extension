// Card number and PIN handling for the three storage modes:
//   none      - never stored
//   local     - card.code = { plain: { number, pin } }
//   encrypted - card.code = { enc: { iv, data } }

import { AppError } from './cards.js';

const ITERATIONS = 600_000;
const CHECK_TEXT = 'gift-card-vault';

export function toBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { iv: toBase64(iv), data: toBase64(data) };
}

export async function decryptText(key, blob) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(blob.iv) }, key, fromBase64(blob.data));
  return new TextDecoder().decode(plain);
}

export async function createVault(passphrase, iterations = ITERATIONS) {
  if (String(passphrase ?? '').length < 8) throw new AppError('passphrase-too-short');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, iterations);
  return { key, meta: { salt: toBase64(salt), iterations, check: await encryptText(key, CHECK_TEXT) } };
}

export async function openVault(meta, passphrase) {
  const key = await deriveKey(passphrase, fromBase64(meta.salt), meta.iterations);
  try {
    if ((await decryptText(key, meta.check)) === CHECK_TEXT) return key;
  } catch {
    // AES-GCM rejects a wrong key; reported below.
  }
  throw new AppError('wrong-passphrase');
}

export function cleanCode(input) {
  const number = String(input?.number ?? '').trim().slice(0, 64);
  const pin = String(input?.pin ?? '').trim().slice(0, 32);
  return number || pin ? { number, pin } : null;
}

export async function encodeCode(mode, input, key) {
  const code = cleanCode(input);
  if (!code || mode === 'none') return undefined;
  if (mode === 'local') return { plain: code };
  if (!key) throw new AppError('locked');
  return { enc: await encryptText(key, JSON.stringify(code)) };
}

export async function decodeCode(field, key) {
  if (!field) return null;
  if (field.plain) return field.plain;
  if (!key) throw new AppError('locked');
  return JSON.parse(await decryptText(key, field.enc));
}

// Session-only copy of the key: cleared when the browser closes, and
// chrome.storage.session isn't readable from content scripts by default.
export async function rememberKey(key) {
  await chrome.storage.session.set({ vaultKey: await crypto.subtle.exportKey('jwk', key) });
}

export async function forgetKey() {
  await chrome.storage.session.remove('vaultKey');
}

export async function recallKey() {
  const { vaultKey } = await chrome.storage.session.get('vaultKey');
  if (!vaultKey) return null;
  return crypto.subtle.importKey('jwk', vaultKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}
