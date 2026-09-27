/**
 * Finds IMAP/SMTP settings for an email address (PLAN.md §4.1):
 *   1. Built-in provider list (no network)
 *   2. Autoconfig from the domain itself, then Mozilla's ISPDB
 *   3. MX records (via DNS-over-HTTPS): a known provider, or ISPDB for the MX domain
 *   4. A guess (imap.<domain> / smtp.<domain>) for the user to confirm
 *
 * Only the domain is sent to ISPDB and the DNS resolver; the full address only
 * goes to the domain's own autoconfig server, as in Thunderbird.
 */
import { domainOf, providerForDomain, providerForMx, providerSettings } from './providers.js';

const ISPDB = 'https://autoconfig.thunderbird.net/v1.1/';
const DOH = 'https://cloudflare-dns.com/dns-query';

const SOCKET_TYPES = { SSL: 'tls', STARTTLS: 'starttls', plain: 'none' };
const SECURITY_RANK = { tls: 0, starttls: 1, none: 2 };

function expandPlaceholders(value, email) {
  const domain = domainOf(email);
  return value
    .replaceAll('%EMAILADDRESS%', email)
    .replaceAll('%EMAILLOCALPART%', email.slice(0, email.lastIndexOf('@')))
    .replaceAll('%EMAILDOMAIN%', domain);
}

function readServer(element, email) {
  const text = (tag) => element.getElementsByTagName(tag)[0]?.textContent.trim();
  const security = SOCKET_TYPES[text('socketType')];
  const port = Number(text('port'));
  const host = text('hostname');
  if (!security || !host || !port) return null;
  return {
    host: expandPlaceholders(host, email).toLowerCase(),
    port,
    security,
    username: expandPlaceholders(text('username') ?? '%EMAILADDRESS%', email),
  };
}

function best(servers) {
  return servers.filter(Boolean).sort((a, b) => SECURITY_RANK[a.security] - SECURITY_RANK[b.security])[0] ?? null;
}

/** Parses a Thunderbird autoconfig (config-v1.1.xml) document. Returns null if it has no IMAP server. */
export function parseAutoconfig(xml, email) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  const incoming = [...doc.getElementsByTagName('incomingServer')].filter((e) => e.getAttribute('type') === 'imap');
  const outgoing = [...doc.getElementsByTagName('outgoingServer')].filter((e) => e.getAttribute('type') === 'smtp');
  const imap = best(incoming.map((e) => readServer(e, email)));
  if (!imap) return null;
  return { imap, smtp: best(outgoing.map((e) => readServer(e, email))) };
}

/** Registrable domain of a host, e.g. mx1.mail.example.co.uk → example.co.uk. */
export function baseDomain(host) {
  const labels = host.replace(/\.$/, '').toLowerCase().split('.');
  const secondLevel = labels.at(-2) ?? '';
  const take = labels.at(-1)?.length === 2 && ['co', 'com', 'net', 'org', 'ac', 'gov', 'edu'].includes(secondLevel) ? 3 : 2;
  return labels.slice(-take).join('.');
}

async function fetchAutoconfig(http, url, email) {
  try {
    const { status, text } = await http(url);
    return status === 200 ? parseAutoconfig(text, email) : null;
  } catch {
    return null;
  }
}

async function lookupMx(http, domain) {
  try {
    const { status, text } = await http(`${DOH}?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: 'application/dns-json' },
    });
    if (status !== 200) return [];
    return (JSON.parse(text).Answer ?? [])
      .filter((a) => a.type === 15)
      .map((a) => a.data.split(' '))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, host]) => host.replace(/\.$/, ''));
  } catch {
    return [];
  }
}

/**
 * Returns `{ source, provider, imap, smtp }`, where source is one of
 * 'provider', 'autoconfig', 'ispdb', 'mx', 'guess'. `provider` is set when a
 * known provider was recognised (for app-password guidance), even for 'mx'.
 */
export async function discover(email, { http }) {
  const domain = domainOf(email);
  if (!domain) return null;

  const known = providerForDomain(domain);
  if (known) return { source: 'provider', provider: known, ...providerSettings(known, email) };

  const encoded = encodeURIComponent(email);
  const [own, wellKnown, ispdb] = await Promise.all([
    fetchAutoconfig(http, `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encoded}`, email),
    fetchAutoconfig(http, `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encoded}`, email),
    fetchAutoconfig(http, `${ISPDB}${domain}`, email),
  ]);
  if (own || wellKnown) return { source: 'autoconfig', provider: null, ...(own ?? wellKnown) };
  if (ispdb) return { source: 'ispdb', provider: null, ...ispdb };

  for (const mx of await lookupMx(http, domain)) {
    const hosted = providerForMx(mx);
    if (hosted) return { source: 'mx', provider: hosted, ...providerSettings(hosted, email) };
    const mxDomain = baseDomain(mx);
    if (mxDomain !== domain) {
      const config = await fetchAutoconfig(http, `${ISPDB}${mxDomain}`, email);
      if (config) return { source: 'mx', provider: null, ...config };
    }
    break;
  }

  return {
    source: 'guess',
    provider: null,
    imap: { host: `imap.${domain}`, port: 993, security: 'tls', username: email },
    smtp: { host: `smtp.${domain}`, port: 465, security: 'tls', username: email },
  };
}
