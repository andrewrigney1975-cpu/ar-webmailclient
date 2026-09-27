/**
 * Built-in knowledge of common providers: server settings (so setup needs no
 * lookup) and whether they need an app password (PLAN.md §4.1, decision D2).
 * Matched by email domain, or by MX host for custom domains hosted there.
 */

export const PROVIDERS = [
  {
    id: 'gmail',
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    mx: [/(^|\.)google\.com$/, /(^|\.)googlemail\.com$/],
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    appPassword: {
      url: 'https://myaccount.google.com/apppasswords',
      steps: 'Turn on 2-Step Verification for your Google account, then create an app password named "Despatch Mobile".',
    },
    // Gmail saves sent mail itself; appending a copy would duplicate it.
    savesSentMail: true,
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    mx: [/(^|\.)icloud\.com$/],
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    appPassword: {
      url: 'https://account.apple.com/account/manage',
      steps: 'Under Sign-In and Security, choose App-Specific Passwords and create one for "Despatch Mobile".',
    },
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.com.au', 'yahoo.ca'],
    mx: [/(^|\.)yahoodns\.net$/],
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    appPassword: {
      url: 'https://login.yahoo.com/account/security',
      steps: 'Open Account Security, choose Generate app password, and create one for "Despatch Mobile".',
    },
  },
  {
    id: 'aol',
    name: 'AOL Mail',
    domains: ['aol.com', 'aim.com'],
    mx: [],
    imap: { host: 'imap.aol.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.aol.com', port: 465, security: 'tls' },
    appPassword: {
      url: 'https://login.aol.com/account/security',
      steps: 'Open Account Security, choose Generate app password, and create one for "Despatch Mobile".',
    },
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    mx: [/(^|\.)messagingengine\.com$/],
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    appPassword: {
      url: 'https://app.fastmail.com/settings/security',
      steps: 'In Settings → Privacy & Security, add an app password with IMAP and SMTP access.',
    },
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    mx: [/(^|\.)zoho\.(com|eu|in)$/],
    imap: { host: 'imap.zoho.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.zoho.com', port: 465, security: 'tls' },
    appPassword: {
      optional: true,
      url: 'https://accounts.zoho.com/home#security/app_password',
      steps: 'If you use two-factor authentication, create an app password for "Despatch Mobile".',
    },
  },
  {
    id: 'microsoft',
    name: 'Outlook.com / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'outlook.com.au'],
    mx: [/\.mail\.protection\.outlook\.com$/, /(^|\.)olc\.protection\.outlook\.com$/],
    // Password sign-in is disabled by Microsoft; OAuth arrives in v2.0 (decision D2).
    unsupportedUntil: '2.0',
  },
];

export function domainOf(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

export function providerForDomain(domain) {
  return PROVIDERS.find((p) => p.domains.includes(domain)) ?? null;
}

export function providerForMx(mxHost) {
  const host = mxHost.replace(/\.$/, '').toLowerCase();
  return PROVIDERS.find((p) => p.mx.some((pattern) => pattern.test(host))) ?? null;
}

/** Server settings for a known provider, with the email address as the username. */
export function providerSettings(provider, email) {
  if (!provider?.imap) return null;
  return {
    imap: { ...provider.imap, username: email },
    smtp: { ...provider.smtp, username: email },
  };
}
