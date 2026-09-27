import { describe, expect, it } from 'vitest';
import { baseDomain, discover, parseAutoconfig } from '../src/js/mail/autoconfig.js';
import { providerForMx } from '../src/js/mail/providers.js';

const EXAMPLE_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.net">
    <domain>example.net</domain>
    <incomingServer type="pop3">
      <hostname>pop.example.net</hostname><port>995</port><socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.net</hostname><port>143</port><socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>IMAP.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.net</hostname><port>587</port><socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

function fakeHttp(routes) {
  const calls = [];
  const http = async (url) => {
    calls.push(url);
    const match = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!match) return { status: 404, text: '' };
    const value = match[1];
    if (value instanceof Error) throw value;
    return { status: 200, text: value };
  };
  return { http, calls };
}

describe('parseAutoconfig', () => {
  it('picks the most secure IMAP server and expands placeholders', () => {
    expect(parseAutoconfig(EXAMPLE_XML, 'jo@example.net')).toEqual({
      imap: { host: 'imap.example.net', port: 993, security: 'tls', username: 'jo' },
      smtp: { host: 'smtp.example.net', port: 587, security: 'starttls', username: 'jo@example.net' },
    });
  });

  it('returns null for invalid XML or no IMAP server', () => {
    expect(parseAutoconfig('<nope', 'a@b.c')).toBeNull();
    expect(parseAutoconfig('<clientConfig></clientConfig>', 'a@b.c')).toBeNull();
  });
});

describe('discover', () => {
  it('uses built-in settings for known providers without any request', async () => {
    const { http, calls } = fakeHttp({});
    const result = await discover('someone@gmail.com', { http });
    expect(result).toMatchObject({ source: 'provider', imap: { host: 'imap.gmail.com', username: 'someone@gmail.com' } });
    expect(result.provider.appPassword.url).toMatch(/^https:\/\//);
    expect(calls).toEqual([]);
  });

  it("prefers the domain's own autoconfig over ISPDB", async () => {
    const { http } = fakeHttp({
      'https://autoconfig.example.net/': EXAMPLE_XML.replace('smtp.example.net', 'own-smtp.example.net'),
      'https://autoconfig.thunderbird.net/v1.1/example.net': EXAMPLE_XML,
    });
    const result = await discover('jo@example.net', { http });
    expect(result.source).toBe('autoconfig');
    expect(result.smtp.host).toBe('own-smtp.example.net');
  });

  it('falls back to ISPDB, then to the MX host', async () => {
    const ispdb = fakeHttp({ 'https://autoconfig.thunderbird.net/v1.1/example.net': EXAMPLE_XML });
    expect((await discover('jo@example.net', { http: ispdb.http })).source).toBe('ispdb');

    const mx = fakeHttp({
      'https://cloudflare-dns.com/dns-query?name=custom.test': JSON.stringify({
        Answer: [
          { type: 15, data: '20 backup.hoster.example.net.' },
          { type: 15, data: '10 mx1.hoster.example.net.' },
        ],
      }),
      'https://autoconfig.thunderbird.net/v1.1/example.net': EXAMPLE_XML,
    });
    const viaMx = await discover('jo@custom.test', { http: mx.http });
    expect(viaMx).toMatchObject({ source: 'mx', imap: { host: 'imap.custom.test' } });
  });

  it('recognises custom domains hosted by known providers', async () => {
    const { http } = fakeHttp({
      'https://cloudflare-dns.com/': JSON.stringify({ Answer: [{ type: 15, data: '1 aspmx.l.google.com.' }] }),
    });
    const result = await discover('me@startup.test', { http });
    expect(result).toMatchObject({ source: 'mx', provider: { id: 'gmail' }, imap: { host: 'imap.gmail.com' } });
  });

  it('guesses when nothing is found, even if requests fail', async () => {
    const { http } = fakeHttp({ 'https://': new Error('offline') });
    expect(await discover('me@nowhere.test', { http })).toMatchObject({
      source: 'guess',
      imap: { host: 'imap.nowhere.test', port: 993, security: 'tls' },
      smtp: { host: 'smtp.nowhere.test', port: 465 },
    });
  });
});

describe('domains', () => {
  it('finds the registrable domain of an MX host', () => {
    expect(baseDomain('mx1.mail.example.co.uk.')).toBe('example.co.uk');
    expect(baseDomain('mx.example.com')).toBe('example.com');
  });

  it('matches Microsoft 365 by MX', () => {
    expect(providerForMx('contoso-com.mail.protection.outlook.com.')?.id).toBe('microsoft');
    expect(providerForMx('mail.example.com')).toBeNull();
  });
});
