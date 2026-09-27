import { describe, expect, it, vi } from 'vitest';
import { addAccount, describeSetupError, SetupError } from '../src/js/accounts/setup.js';
import { listAccounts } from '../src/js/db/repo-accounts.js';
import { createMailApi, MailErrorCode } from '../src/js/mail/bridge.js';
import { DespatchMailWeb } from '../src/js/mail/web-mail.js';
import { providerForDomain } from '../src/js/mail/providers.js';
import { pickDefaultAccent, FALLBACK_PALETTE } from '../src/js/theme/accents.js';
import { testDatabase } from './helpers.js';

const discovered = {
  source: 'ispdb',
  provider: null,
  imap: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me@example.com' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me@example.com' },
};

async function fixture({ colors = [] } = {}) {
  const db = await testDatabase();
  const plugin = new DespatchMailWeb();
  plugin.getDynamicColors = async () => ({ colors });
  const mail = createMailApi(plugin);
  let n = 0;
  const deps = {
    db,
    mail,
    discover: vi.fn(async () => discovered),
    existingAccounts: [],
    newId: () => `new-${++n}`,
  };
  return { db, mail, deps };
}

async function setupError(promise) {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(SetupError);
  return error;
}

describe('addAccount', () => {
  it('discovers settings, tests them, then saves the account and password', async () => {
    const { db, mail, deps } = await fixture({ colors: ['#aa0000'] });

    const account = await addAccount({ email: ' Me@Example.com ', displayName: ' Me ', password: 'pw' }, deps);

    expect(deps.discover).toHaveBeenCalledWith('me@example.com');
    expect(account).toMatchObject({ id: 'new-1', email: 'me@example.com', displayName: 'Me', accentColor: '#aa0000' });
    expect(await mail.hasCredentials('new-1')).toBe(true);
    expect((await listAccounts(db)).map((a) => a.imap.host)).toEqual(['imap.example.com']);
  });

  it('saves nothing when the connection test fails', async () => {
    const { db, mail, deps } = await fixture();

    const error = await setupError(addAccount({ email: 'me@example.com', password: 'wrong' }, deps));

    expect(error.code).toBe(MailErrorCode.AUTH_FAILED);
    expect(error.settings.imap.host).toBe('imap.example.com');
    expect(await mail.hasCredentials('new-1')).toBe(false);
    expect(await listAccounts(db)).toEqual([]);
  });

  it('uses manual settings without discovery', async () => {
    const { deps } = await fixture();
    const settings = { imap: { ...discovered.imap, host: 'mail.custom.test' }, smtp: null };

    const account = await addAccount({ email: 'me@custom.test', password: 'pw', settings }, deps);

    expect(deps.discover).not.toHaveBeenCalled();
    expect(account.imap.host).toBe('mail.custom.test');
    expect(account.smtp).toBeNull();
  });

  it('refuses Microsoft accounts until v2.0', async () => {
    const { deps } = await fixture();
    deps.discover.mockResolvedValue({ source: 'provider', provider: providerForDomain('outlook.com') });

    const error = await setupError(addAccount({ email: 'me@outlook.com', password: 'pw' }, deps));
    expect(error.code).toBe(MailErrorCode.BASIC_AUTH_DISABLED);
    expect(describeSetupError(error).message).toMatch(/Despatch Mobile 2\.0/);
  });

  it('rejects invalid and duplicate addresses', async () => {
    const { deps } = await fixture();
    expect((await setupError(addAccount({ email: 'nope', password: 'pw' }, deps))).code).toBe('INVALID_EMAIL');

    const first = await addAccount({ email: 'me@example.com', password: 'pw' }, deps);
    deps.existingAccounts = [first];
    expect((await setupError(addAccount({ email: 'me@example.com', password: 'pw' }, deps))).code).toBe(
      'DUPLICATE_ACCOUNT',
    );
  });
});

describe('describeSetupError', () => {
  it('explains app passwords for providers that require them', () => {
    const gmail = providerForDomain('gmail.com');
    const text = describeSetupError(new SetupError(MailErrorCode.AUTH_FAILED, 'x', { provider: gmail }));
    expect(text.message).toMatch(/app password/);
    expect(text.showManual).toBe(false);
  });

  it('opens the manual form for connection problems', () => {
    const text = describeSetupError(
      new SetupError(MailErrorCode.CONNECTION_FAILED, 'x', { settings: { imap: { host: 'imap.nope.test' } } }),
    );
    expect(text).toMatchObject({ showManual: true, message: expect.stringContaining('imap.nope.test') });
  });
});

describe('pickDefaultAccent', () => {
  it('prefers unused wallpaper colours, then the palette', () => {
    expect(pickDefaultAccent([], ['#112233'])).toBe('#112233');
    expect(pickDefaultAccent(['#112233'], ['#112233'])).toBe(FALLBACK_PALETTE[0]);
    expect(pickDefaultAccent([FALLBACK_PALETTE[0].toUpperCase()], [])).toBe(FALLBACK_PALETTE[1]);
  });
});
