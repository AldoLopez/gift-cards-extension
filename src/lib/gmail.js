// Read-only Gmail access through the Chrome-managed OAuth token.

import { AppError } from './cards.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_MESSAGES = 300;
const CONCURRENCY = 5;

export function isConfigured() {
  return !chrome.runtime.getManifest().oauth2.client_id.startsWith('REPLACE');
}

export async function getToken(interactive) {
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    if (result?.token) return result.token;
  } catch {
    // Reported below: expired grant, no Chrome sign-in, or a declined prompt.
  }
  throw new AppError('gmail-auth');
}

async function gmailGet(path, token) {
  let current = token;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${current}` } });
    if (response.ok) return response.json();
    if (response.status !== 401 || attempt === 1) {
      throw new AppError(response.status === 401 || response.status === 403 ? 'gmail-auth' : 'gmail-unavailable');
    }
    await chrome.identity.removeCachedAuthToken({ token: current });
    current = await getToken(false);
  }
  throw new AppError('gmail-unavailable');
}

export function buildQuery(emailDomains, afterMs) {
  const senders = [...new Set(emailDomains)].join(' OR ');
  const after = Math.floor(afterMs / 1000);
  return `from:(${senders}) subject:(order OR receipt OR confirmation OR purchase OR invoice OR payment) after:${after}`;
}

async function listIds(query, token) {
  const ids = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ q: query, maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await gmailGet(`/messages?${params}`, token);
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken ?? '';
  } while (pageToken && ids.length < MAX_MESSAGES);
  return ids.slice(0, MAX_MESSAGES);
}

export function decodeBody(data) {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function senderDomain(from) {
  const address = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

function collectBodies(part, bodies) {
  if (!part) return;
  if (part.body?.data && !part.filename) {
    if (part.mimeType === 'text/plain' && !bodies.plain) bodies.plain = decodeBody(part.body.data);
    if (part.mimeType === 'text/html' && !bodies.html) bodies.html = decodeBody(part.body.data);
  }
  (part.parts ?? []).forEach((child) => collectBodies(child, bodies));
}

export function extractMessage(raw) {
  const headers = raw.payload?.headers ?? [];
  const header = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const bodies = {};
  collectBodies(raw.payload, bodies);
  return {
    id: raw.id,
    internalDate: Number(raw.internalDate),
    subject: header('subject').slice(0, 300),
    senderDomain: senderDomain(header('from')),
    authResults: header('authentication-results'),
    bodies,
  };
}

export async function fetchMessages(query, token) {
  const ids = await listIds(query, token);
  const messages = [];
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      messages.push(extractMessage(await gmailGet(`/messages/${id}?format=full`, token)));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return messages.sort((a, b) => a.internalDate - b.internalDate);
}

export async function disconnect() {
  try {
    const token = await getToken(false);
    await chrome.identity.removeCachedAuthToken({ token });
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', mode: 'no-cors' });
  } catch {
    // Already disconnected or offline; the extension stops scanning either way.
  }
}
