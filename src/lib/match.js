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

// In Chrome, *.example.com also covers example.com itself.
export function originPatterns(domains) {
  return domains.map((d) => `*://*.${d}/*`);
}

export function customMerchant(name, domainInput) {
  const domain = normalizeDomain(domainInput);
  const cleanName = String(name ?? '').trim().slice(0, 60);
  if (!domain || !cleanName) return null;
  return { id: `custom:${domain}`, name: cleanName, domains: [domain], emailDomains: [domain], balanceUrl: null };
}

export function allMerchants(catalog, custom) {
  return [...catalog, ...custom];
}
