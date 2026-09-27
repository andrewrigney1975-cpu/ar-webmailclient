import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildResponse,
  draftFromMailto,
  emptyDraft,
  formatAddress,
  isBlankDraft,
  parseAddressList,
  rankContacts,
  toOutgoing,
  validateDraft,
} from '../src/js/compose/compose-model.js';
import { recordContacts, searchContacts } from '../src/js/db/repo-contacts.js';
import { getDraft, listOutbox, saveDraft } from '../src/js/db/repo-drafts.js';
import { listFolders } from '../src/js/db/repo-folders.js';
import { getMessage, listMessages } from '../src/js/db/repo-messages.js';
import { createOutbox, retryDelay, savesSentMail, UNDO_SEND_MS } from '../src/js/mail/outbox.js';
import { syncFolder, syncFolderList } from '../src/js/mail/sync.js';
import { createStore } from '../src/js/store.js';
import { DmAddressInput } from '../src/js/views/components/dm-address-input.js';
import { syncFixture, testDatabase } from './helpers.js';

const me = { id: 'acc', email: 'me@example.com', displayName: 'Me', signature: 'Me\nExample Ltd' };
const message = {
  id: 7,
  messageId: '<m7@example.org>',
  references: ['<m1@example.org>'],
  subject: 'Plans',
  from: { name: 'Bob', address: 'bob@example.org' },
  to: [{ name: 'Me', address: 'me@example.com' }, { name: 'Zoë', address: 'zoe@example.net' }],
  cc: [{ name: null, address: 'carol@example.com' }],
  replyTo: [],
  dateSent: Date.UTC(2026, 9, 5, 9),
  attachments: [
    { partId: '2', filename: 'plan.pdf', mimeType: 'application/pdf', size: 10, inline: false },
    { partId: '3', filename: null, mimeType: 'image/png', size: 5, inline: true, contentId: 'x' },
  ],
};

describe('addresses', () => {
  it('parses lists with quoted names, angle brackets and separators', () => {
    expect(parseAddressList('"Smith, Bob" <Bob@Example.org>, zoe@example.net; Carol <c@x.io>')).toEqual([
      { name: 'Smith, Bob', address: 'bob@example.org' },
      { name: null, address: 'zoe@example.net' },
      { name: 'Carol', address: 'c@x.io' },
    ]);
    expect(parseAddressList('mailto:a@b.co')).toEqual([{ name: null, address: 'a@b.co' }]);
  });

  it('formats names that need quoting', () => {
    expect(formatAddress({ name: 'Smith, Bob', address: 'b@x.io' })).toBe('"Smith, Bob" <b@x.io>');
    expect(formatAddress({ name: null, address: 'b@x.io' })).toBe('b@x.io');
  });

  it('validates drafts before sending', () => {
    expect(validateDraft({ to: [], cc: [], bcc: [] })).toEqual(['Add at least one recipient.']);
    expect(validateDraft({ to: [{ address: 'nope' }], cc: [], bcc: [] })[0]).toMatch(/nope/);
    expect(validateDraft({ to: [{ address: 'ok@x.io' }], cc: [], bcc: [] })).toEqual([]);
  });
});

describe('buildResponse', () => {
  const context = { account: me, myAddresses: ['me@example.com'] };

  it('replies to the sender with threading headers, quote and signature', () => {
    const draft = buildResponse('reply', message, 'Friday?\nOk', context);
    expect(draft.to).toEqual([{ name: 'Bob', address: 'bob@example.org' }]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe('Re: Plans');
    expect(draft.inReplyTo).toBe('<m7@example.org>');
    expect(draft.references).toEqual(['<m1@example.org>', '<m7@example.org>']);
    expect(draft.text).toMatch(/^\n\n-- \nMe\nExample Ltd\n\nOn .+, Bob wrote:\n> Friday\?\n> Ok$/);
    expect(draft.replyOf).toBe(7);
  });

  it('replies to everyone except me', () => {
    const draft = buildResponse('replyall', message, '', context);
    expect(draft.to.map((p) => p.address)).toEqual(['bob@example.org']);
    expect(draft.cc.map((p) => p.address)).toEqual(['zoe@example.net', 'carol@example.com']);
  });

  it('respects Reply-To, and replies to my own message’s recipients', () => {
    expect(buildResponse('reply', { ...message, replyTo: [{ name: 'List', address: 'list@x.io' }] }, '', context).to).toEqual([
      { name: 'List', address: 'list@x.io' },
    ]);
    const mine = { ...message, from: { name: 'Me', address: 'me@example.com' }, to: [{ name: 'Bob', address: 'bob@example.org' }], cc: [] };
    expect(buildResponse('reply', mine, '', context).to.map((p) => p.address)).toEqual(['bob@example.org']);
  });

  it('does not stack reply prefixes', () => {
    expect(buildResponse('reply', { ...message, subject: 'RE: Plans' }, '', context).subject).toBe('RE: Plans');
    expect(buildResponse('forward', { ...message, subject: 'Fwd: Plans' }, '', context).subject).toBe('Fwd: Plans');
  });

  it('forwards with a header, the body and the real attachments', () => {
    const draft = buildResponse('forward', message, 'Body text', context);
    expect(draft.to).toEqual([]);
    expect(draft.subject).toBe('Fwd: Plans');
    expect(draft.text).toContain('---------- Forwarded message ---------\nFrom: Bob <bob@example.org>');
    expect(draft.text).toContain('Cc: carol@example.com');
    expect(draft.text.endsWith('Body text')).toBe(true);
    expect(draft.attachments).toEqual([
      { filename: 'plan.pdf', mimeType: 'application/pdf', size: 10, fromMessage: { id: 7, partId: '2' } },
    ]);
    expect(draft.forwardOf).toBe(7);
  });

  it('builds new, mailto and outgoing messages', () => {
    const blank = emptyDraft(me);
    expect(blank.text).toBe('\n\n-- \nMe\nExample Ltd');
    expect(isBlankDraft(blank, me)).toBe(true);
    expect(isBlankDraft({ ...blank, subject: 'x' }, me)).toBe(false);

    const mailto = draftFromMailto('mailto:a@b.co,c@d.io?subject=Hi%20there&cc=e@f.io&body=Hello', me);
    expect(mailto).toMatchObject({ to: [{ address: 'a@b.co' }, { address: 'c@d.io' }], cc: [{ address: 'e@f.io' }], subject: 'Hi there' });
    expect(mailto.text.startsWith('Hello')).toBe(true);

    const outgoing = toOutgoing({ ...blank, to: [{ name: null, address: 'a@b.co' }], attachments: [{ filename: 'f', mimeType: 'text/plain', path: '/c/f', size: 1 }] }, me);
    expect(outgoing).toMatchObject({ from: { name: 'Me', address: 'me@example.com' }, attachments: [{ filename: 'f', mimeType: 'text/plain', path: '/c/f' }] });
  });
});

describe('contacts for autocomplete', () => {
  it('matches address and name word prefixes and ranks by use and recency', async () => {
    const db = await testDatabase();
    const now = Date.UTC(2026, 9, 1);
    await db.transaction(async (tx) => {
      await recordContacts(tx, [{ name: 'Bob Smith', address: 'bob@example.org' }], 'received', now - 400 * 86_400_000);
      await recordContacts(tx, [{ name: 'Bobbie Jones', address: 'bj@example.org' }], 'sent', now - 86_400_000);
      await recordContacts(tx, [{ name: 'Rob Bobson', address: 'rob@x.io' }], 'received', now);
      await recordContacts(tx, [{ name: 'Alice', address: 'alice@x.io' }], 'sent', now);
    });

    const results = await searchContacts(db, 'bob', { rank: (rows, q) => rankContacts(rows, q, now) });
    expect(results.map((r) => r.address)).toEqual(['bj@example.org', 'rob@x.io', 'bob@example.org']);
    expect(await searchContacts(db, '%')).toEqual([]);
  });
});

describe('outbox', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  async function fixture() {
    const fx = await syncFixture();
    await syncFolderList(fx);
    const folders = await listFolders(fx.db);
    await syncFolder({ ...fx, folder: folders.find((f) => f.role === 'inbox') });
    let clock = Date.UTC(2026, 9, 1);
    const store = createStore({ accounts: [fx.account], folders: await listFolders(fx.db), online: true, outbox: [] });
    const outbox = createOutbox({ db: fx.db, mail: fx.mail, store, now: () => clock });
    return { ...fx, store, outbox, tick: (ms) => (clock += ms) };
  }

  const outgoing = (to = 'bob@example.org') => ({
    from: { name: 'Me', address: 'user@example.com' },
    to: [{ name: 'Bob', address: to }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Re: Project kickoff',
    text: 'On my way',
    html: null,
    inReplyTo: '<kickoff-3@example.org>',
    references: [],
    attachments: [],
  });

  it('waits for the undo window, then sends, files in Sent and marks the original answered', async () => {
    const fx = await fixture();
    const [original] = await listMessages(fx.db, { unified: true });
    await saveDraft(fx.db, { id: 'd1', accountId: fx.account.id, data: {} });
    await fx.outbox.queue({ accountId: fx.account.id, outgoing: outgoing(), replyOf: original.id, draftId: 'd1' });

    await fx.outbox.process();
    expect(fx.plugin.sent).toHaveLength(0);

    fx.tick(UNDO_SEND_MS);
    await fx.outbox.process();
    expect(fx.plugin.sent).toHaveLength(1);
    expect(await listOutbox(fx.db)).toEqual([]);
    expect(fx.store.get().outbox).toEqual([]);
    expect((await getMessage(fx.db, original.id)).flags).toContain('\\Answered');
    expect(await getDraft(fx.db, 'd1')).toBeNull();
    expect((await fx.mail.fetchEnvelopes(fx.account, 'Sent', { latest: 5 })).map((e) => e.subject)).toEqual(['Re: Project kickoff']);
  });

  it('can be taken back during the undo window', async () => {
    const fx = await fixture();
    const id = await fx.outbox.queue({ accountId: fx.account.id, outgoing: outgoing() });
    expect((await fx.outbox.cancel(id)).data.outgoing.subject).toBe('Re: Project kickoff');
    fx.tick(UNDO_SEND_MS);
    await fx.outbox.process();
    expect(fx.plugin.sent).toHaveLength(0);
    expect(await fx.outbox.cancel(id)).toBeNull();
  });

  it('retries transient failures with backoff and holds permanent ones', async () => {
    const fx = await fixture();
    const send = vi.spyOn(fx.mail, 'send').mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'CONNECTION_FAILED' }));
    await fx.outbox.queue({ accountId: fx.account.id, outgoing: outgoing() });
    fx.tick(UNDO_SEND_MS);
    await fx.outbox.process();
    const [item] = await listOutbox(fx.db);
    expect(item).toMatchObject({ attempts: 1, lastError: { code: 'CONNECTION_FAILED' } });

    fx.tick(retryDelay(1));
    await fx.outbox.process();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await listOutbox(fx.db)).toEqual([]);

    send.mockRejectedValueOnce(Object.assign(new Error('rejected'), { code: 'RECIPIENT_REJECTED' }));
    const id = await fx.outbox.queue({ accountId: fx.account.id, outgoing: outgoing() });
    fx.tick(UNDO_SEND_MS);
    await fx.outbox.process();
    fx.tick(24 * 3600_000);
    await fx.outbox.process();
    expect(send).toHaveBeenCalledTimes(3); // held, not retried
    await fx.outbox.retry(id);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('waits while offline, and knows Gmail files sent mail itself', async () => {
    const fx = await fixture();
    fx.store.set({ online: false });
    await fx.outbox.queue({ accountId: fx.account.id, outgoing: outgoing() });
    fx.tick(UNDO_SEND_MS);
    await fx.outbox.process();
    expect(fx.plugin.sent).toHaveLength(0);
    expect(retryDelay(1)).toBe(30_000);
    expect(retryDelay(20)).toBe(30 * 60_000);
    expect(savesSentMail({ imap: { host: 'imap.gmail.com' } })).toBe(true);
    expect(savesSentMail({ imap: { host: 'mymail.brinkster.com' } })).toBe(false);
  });
});

describe('<dm-address-input>', () => {
  function mount() {
    const element = new DmAddressInput();
    document.body.append(element);
    const input = element.querySelector('input');
    const type = async (text) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await Promise.resolve();
      await Promise.resolve();
    };
    const key = (k) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    return { element, input, type, key };
  }

  it('turns typed text into chips on comma, and removes the last with Backspace', async () => {
    const { element, type, key } = mount();
    await type('bob@example.org,');
    expect(element.addresses).toEqual([{ name: null, address: 'bob@example.org' }]);
    key('Backspace');
    expect(element.addresses).toEqual([]);
  });

  it('offers suggestions and picks one with the keyboard', async () => {
    const { element, type, key } = mount();
    element.suggest = async () => [
      { name: 'Bob', address: 'bob@example.org' },
      { name: 'Bobbie', address: 'bj@example.org' },
    ];
    const changes = vi.fn();
    element.addEventListener('change', changes);
    await type('bo');
    expect(element.querySelectorAll('[role=option]')).toHaveLength(2);
    expect(element.querySelector('input').getAttribute('aria-expanded')).toBe('true');
    key('ArrowDown');
    key('Enter');
    expect(element.addresses).toEqual([{ name: 'Bobbie', address: 'bj@example.org' }]);
    expect(changes).toHaveBeenCalled();
    expect(element.querySelector('ul').hidden).toBe(true);
  });

  it('marks invalid addresses and keeps pasted lists', async () => {
    const { element, input } = mount();
    const paste = new Event('paste', { cancelable: true });
    paste.clipboardData = { getData: () => 'a@b.co, not-an-address' };
    input.dispatchEvent(paste);
    expect(element.addresses.map((p) => p.address)).toEqual(['a@b.co', 'not-an-address']);
    expect(element.querySelectorAll('.chip--invalid')).toHaveLength(1);
  });
});
