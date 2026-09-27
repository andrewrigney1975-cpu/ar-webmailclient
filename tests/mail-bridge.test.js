import { beforeEach, describe, expect, it } from 'vitest';
import { MailError, MailErrorCode, mail, toNativeAccount } from '../src/js/mail/bridge.js';

let counter = 0;

function account(overrides = {}) {
  counter += 1;
  return {
    id: `acc-${counter}`,
    email: 'alice@example.com',
    displayName: 'Alice',
    accentColor: '#ff0000',
    imap: { host: 'imap.example.com', port: 993, security: 'tls', username: 'alice', extra: true },
    smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'alice' },
    ...overrides,
  };
}

async function expectCode(promise, code) {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(MailError);
  expect(error.code).toBe(code);
}

describe('toNativeAccount', () => {
  it('sends only connection settings', () => {
    expect(toNativeAccount(account({ id: 'x' }))).toEqual({
      id: 'x',
      email: 'alice@example.com',
      displayName: 'Alice',
      imap: { host: 'imap.example.com', port: 993, security: 'tls', username: 'alice' },
      smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'alice' },
    });
  });

  it('allows accounts without SMTP', () => {
    expect(toNativeAccount(account({ smtp: undefined })).smtp).toBeNull();
  });
});

describe('mail bridge (web implementation)', () => {
  let acc;

  beforeEach(async () => {
    acc = account();
    await mail.setCredentials(acc.id, 'secret');
  });

  it('tests a connection with an unsaved password', async () => {
    const other = account();
    const result = await mail.testConnection(other, { password: 'secret' });
    expect(result.capabilities).toContain('IDLE');
    await expectCode(mail.testConnection(other, { password: 'wrong' }), MailErrorCode.AUTH_FAILED);
  });

  it('tracks stored credentials', async () => {
    expect(await mail.hasCredentials(acc.id)).toBe(true);
    await mail.deleteCredentials(acc.id);
    expect(await mail.hasCredentials(acc.id)).toBe(false);
    await expectCode(mail.listFolders(acc), MailErrorCode.NO_CREDENTIALS);
  });

  it('lists folders with roles and status', async () => {
    const folders = await mail.listFolders(acc);
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk']);

    const status = await mail.folderStatus(acc, 'INBOX');
    expect(status).toMatchObject({ messages: 5, unseen: 4, uidNext: 6 });
  });

  it('fetches envelopes by latest, range and UIDs', async () => {
    const latest = await mail.fetchEnvelopes(acc, 'INBOX', { latest: 2 });
    expect(latest.map((m) => m.uid)).toEqual([4, 5]);
    expect(latest[0]).not.toHaveProperty('body');

    expect((await mail.fetchEnvelopes(acc, 'INBOX', { fromUid: 4 })).map((m) => m.uid)).toEqual([4, 5]);
    expect((await mail.fetchEnvelopes(acc, 'INBOX', { uids: [1, 99] })).map((m) => m.uid)).toEqual([1]);
  });

  it('reports attachments but not inline images', async () => {
    const [invoice, digest] = await mail.fetchEnvelopes(acc, 'INBOX', { uids: [3, 4] });
    expect(invoice.hasAttachments).toBe(true);
    expect(digest.hasAttachments).toBe(false);

    const body = await mail.fetchBody(acc, 'INBOX', 3);
    expect(body.attachments[0]).toMatchObject({ partId: '2', filename: 'invoice-1042.pdf' });
    const download = await mail.downloadAttachment(acc, 'INBOX', 3, '2', 'invoice-1042.pdf');
    expect(download.size).toBe(48_213);
  });

  it('sets flags and moves messages', async () => {
    await mail.setFlags(acc, 'INBOX', [1, 2], { add: ['\\Seen', '\\Flagged'] });
    await mail.setFlags(acc, 'INBOX', [2], { remove: ['\\Flagged'] });
    const flags = await mail.fetchFlags(acc, 'INBOX', { uids: [1, 2] });
    expect(flags).toEqual([
      { uid: 1, flags: ['\\Seen', '\\Flagged'] },
      { uid: 2, flags: ['\\Seen'] },
    ]);

    const newUids = await mail.moveMessages(acc, 'INBOX', [1], 'Archive');
    expect(newUids).toEqual([1]);
    expect((await mail.folderStatus(acc, 'INBOX')).messages).toBe(4);
    expect((await mail.fetchEnvelopes(acc, 'Archive', { latest: 10 }))[0].subject).toBe('Project kickoff');
  });

  it('sends and saves to Sent', async () => {
    const result = await mail.send(
      acc,
      {
        from: { name: 'Alice', address: 'alice@example.com' },
        to: [{ name: 'Bob', address: 'bob@example.org' }],
        subject: 'Re: Project kickoff',
        text: 'Sounds good',
        inReplyTo: '<kickoff-3@example.org>',
        references: ['<kickoff@example.org>', '<kickoff-3@example.org>'],
      },
      { sentFolder: 'Sent' },
    );
    expect(result.messageId).toMatch(/@example\.com>$/);

    const [saved] = await mail.fetchEnvelopes(acc, 'Sent', { uids: [result.sentFolderUid] });
    expect(saved).toMatchObject({ messageId: result.messageId, flags: ['\\Seen'], inReplyTo: '<kickoff-3@example.org>' });
  });

  it('normalises errors', async () => {
    await expectCode(mail.folderStatus(acc, 'Nope'), MailErrorCode.FOLDER_NOT_FOUND);
    await expectCode(mail.fetchBody(acc, 'INBOX', 999), MailErrorCode.MESSAGE_NOT_FOUND);
    await expectCode(
      mail.send(acc, { from: { address: 'alice@example.com' }, to: [], subject: 'x', text: 'x' }),
      MailErrorCode.INVALID_ARGUMENT,
    );
  });
});
