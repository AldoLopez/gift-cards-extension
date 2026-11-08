// Matching page hostnames and email senders to merchants.

export function normalizeDomain(input) {
  let text = String(input ?? '').trim().toLowerCase();
  text = text.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].split(':')[0];
  text = text.replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text) ? text : null;
}

export function hostMatches(host, domain) {
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

export function findMerchantByHost(merchants, host) {
  return merchants.find((m) => m.domains.some((d) => hostMatches(host, d))) ?? null;
}

export function findMerchantByEmailDomain(merchants, senderDomain) {
  return merchants.find((m) => m.emailDomains.some((d) => hostMatches(senderDomain, d))) ?? null;
}

const CHECKOUT_SEGMENTS = new Set([
  'cart', 'viewcart', 'view-cart', 'mycart', 'my-cart', 'shoppingcart', 'shopping-cart',
  'basket', 'bag', 'mybag', 'my-bag', 'shoppingbag', 'shopping-bag',
  'check-out', 'securecheckout', 'secure-checkout', 'payment',
  'placeorder', 'place-order', 'review-order', 'order-review',
]);

// Compares whole path pieces, so a product like /p/cart-organizer doesn't count.
export function isCheckoutPage(host, path) {
  if (/^(checkout|cart|pay)\./i.test(host)) return true;
  const text = String(path ?? '').toLowerCase();
  if (text.includes('/gp/buy/')) return true;
  return text.split(/[/#?&]+/).some((part) => {
    const segment = part.replace(/\.(html?|jsp|aspx?|do|php)$/, '');
    return CHECKOUT_SEGMENTS.has(segment) || segment.startsWith('checkout');
  });
}

// What the add form should start with for the site being viewed: a known
// store, or a new store prefilled with this website.
export function siteDefault(merchants, host) {
  if (!host) return null;
  const merchant = findMerchantByHost(merchants, host);
  if (merchant) return { merchantId: merchant.id };
  const domain = normalizeDomain(host);
  return domain ? { domain } : null;
}

export function cardsHereFirst(cards, merchantId) {
  if (!merchantId) return cards;
  return [...cards.filter((c) => c.merchantId === merchantId), ...cards.filter((c) => c.merchantId !== merchantId)];
}

// In Chrome, *.example.com also covers example.com itself.
export function originPatterns(domains) {
  return domains.map((d) => `*://*.${d}/*`);
}

// Accepts typed text ("a.com, b.com") or an array. Null if any entry is invalid.
export function parseDomains(input) {
  const parts = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/)).filter(Boolean);
  const domains = parts.map(normalizeDomain);
  if (!domains.length || domains.includes(null)) return null;
  return [...new Set(domains)];
}

export function customMerchant(name, sites) {
  const domains = parseDomains(sites);
  const cleanName = String(name ?? '').trim().slice(0, 60);
  if (!domains || !cleanName) return null;
  return { id: `custom:${domains[0]}`, name: cleanName, domains, emailDomains: domains, balanceUrl: null };
}

// Each website can belong to one store, or the wrong card would be shown there.
export function conflictingMerchant(merchants, domains, selfId) {
  return (
    merchants.find(
      (m) => m.id !== selfId && m.domains.some((e) => domains.some((d) => hostMatches(d, e) || hostMatches(e, d))),
    ) ?? null
  );
}

export function allMerchants(catalog, custom, extraDomains = {}) {
  return [...catalog, ...custom].map((m) =>
    extraDomains[m.id]?.length ? { ...m, domains: [...m.domains, ...extraDomains[m.id]] } : m,
  );
}
