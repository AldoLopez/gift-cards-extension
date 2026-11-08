// Shared helpers for the popup and settings pages.

const ERROR_TEXT = {
  locked: 'Unlock your codes first.',
  'wrong-passphrase': 'That passphrase is incorrect.',
  'passphrase-too-short': 'Use a passphrase of at least 8 characters.',
  'passphrase-required': 'This file has codes in it. Enter the passphrase it was exported with.',
  'invalid-amount': 'Enter an amount like 25.00.',
  'invalid-domain': 'Enter a website like example.com.',
  'merchant-required': 'Choose a store.',
  'card-not-found': 'That card no longer exists.',
  'entry-not-found': 'That item is already gone.',
  'bad-file': 'That file isn\'t a gift card export.',
  'gmail-not-configured': 'Gmail needs a one-time Google setup first. Follow docs/SETUP.md, then reload the extension.',
  'gmail-auth': 'Google didn\'t grant access. Check that you\'re signed in to Chrome with the Gmail account you want to scan, and that it\'s listed as a test user.',
  'gmail-unavailable': 'Gmail couldn\'t be reached. Try again in a moment.',
};

export function errorText(code) {
  return ERROR_TEXT[code] ?? 'Something went wrong. Reload the extension and try again.';
}

export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    const error = new Error(response?.error ?? 'unexpected');
    error.code = response?.error ?? 'unexpected';
    throw error;
  }
  return response.data;
}

// All text goes through textContent, so email subjects and imported names can't inject markup.
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function timeAgo(ms) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export function cardTitle(card) {
  return card.label || (card.last4 ? `Ending ${card.last4}` : 'Gift card');
}

export function bandColor(text) {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 62% 46%)`;
}
