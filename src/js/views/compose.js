/**
 * Compose screen (PLAN.md §4.8). Opened by route: #/compose (new),
 * #/compose/reply|replyall|forward/<message id>, #/compose/draft/<draft id>
 * (or msg:<id> for a draft that only exists on the server), and
 * #/compose/mailto/<encoded mailto: URL>.
 *
 * The draft autosaves locally while typing. Leaving the screen saves it to
 * the server's Drafts folder (or deletes it if it's blank). Send hands the
 * message to the outbox, which waits a few seconds so it can be undone.
 */
import { html, icon, render } from '../html.js';
import { getMessage } from '../db/repo-messages.js';
import { deleteDraft, getDraft, saveDraft, setDraftRemoteUid } from '../db/repo-drafts.js';
import { searchContacts } from '../db/repo-contacts.js';
import {
  buildResponse,
  draftFromMailto,
  emptyDraft,
  isBlankDraft,
  rankContacts,
  toOutgoing,
  validateDraft,
} from '../compose/compose-model.js';
import { MAX_ATTACHMENTS_BYTES, resolveAttachments, stageFile, totalSize } from '../compose/attachments.js';
import { formatSize, htmlToText } from '../util/format.js';
import './components/dm-address-input.js';

const AUTOSAVE_MS = 1500;

export function createComposeView({ element, db, store, mail, outbox, router, snackbar, onError }) {
  let state = null; // { draftId, draft, remoteUid, discarding }
  let autosaveTimer = null;
  let openToken = 0;

  const accountById = (id) => store.get().accounts.find((a) => a.id === id);
  const folderOf = (message) => store.get().folders.find((f) => f.id === message.folderId);
  const draftsFolder = (account) =>
    store.get().folders.find((f) => f.accountId === account.id && f.role === 'drafts')?.path ?? null;

  function defaultAccount() {
    const { accounts, folders, lastMailboxRoute } = store.get();
    const folder = folders.find((f) => String(f.id) === lastMailboxRoute?.folderId);
    return accounts.find((a) => a.id === folder?.accountId) ?? accounts[0];
  }

  async function bodyTextOf(message) {
    if (message.bodyFetchedAt) return message.bodyText ?? htmlToText(message.bodyHtml ?? '');
    const folder = folderOf(message);
    const body = await mail.fetchBody(accountById(message.accountId), folder.path, message.uid);
    message.attachments = body.attachments;
    return body.text ?? htmlToText(body.html ?? '');
  }

  async function initialState(route) {
    const myAddresses = store.get().accounts.map((a) => a.email);
    if (route.mode === 'reply' || route.mode === 'replyall' || route.mode === 'forward') {
      const message = await getMessage(db, Number(route.id));
      if (!message) throw new Error('That message is no longer available.');
      const account = accountById(message.accountId);
      const draft = buildResponse(route.mode, message, await bodyTextOf(message), { account, myAddresses });
      return { draftId: crypto.randomUUID(), draft, remoteUid: null };
    }
    if (route.mode === 'draft' && route.id.startsWith('msg:')) {
      // A draft saved on the server (by this app or another client).
      const message = await getMessage(db, Number(route.id.slice(4)));
      if (!message) throw new Error('That draft is no longer available.');
      const draft = {
        ...emptyDraft(accountById(message.accountId)),
        to: message.to,
        cc: message.cc,
        subject: message.subject ?? '',
        text: await bodyTextOf(message),
        inReplyTo: message.inReplyTo,
        references: message.references,
      };
      return { draftId: crypto.randomUUID(), draft, remoteUid: message.uid };
    }
    if (route.mode === 'draft') {
      const saved = await getDraft(db, route.id);
      if (!saved) throw new Error('That draft is no longer available.');
      return { draftId: saved.id, draft: saved.data, remoteUid: saved.remoteUid };
    }
    const account = defaultAccount();
    const draft = route.mode === 'mailto' ? draftFromMailto(decodeURIComponent(route.id), account) : emptyDraft(account);
    return { draftId: crypto.randomUUID(), draft, remoteUid: null };
  }

  // --- Rendering -------------------------------------------------------------------------------------

  function attachmentList() {
    const { attachments } = state.draft;
    if (attachments.length === 0) return '';
    const total = totalSize(attachments);
    return html`
      <ul class="compose__attachments" role="list">
        ${attachments.map(
          (a, index) => html`<li class="compose__attachment">
            ${icon(a.mimeType?.startsWith('image/') ? 'image' : 'file')}
            <span class="attachment__name">${a.filename}</span>
            <span class="attachment__size">${a.size ? formatSize(a.size) : ''}</span>
            <button class="icon-button" type="button" data-compose="remove-attachment" data-index="${index}">
              ${icon('close', `Remove ${a.filename}`)}
            </button>
          </li>`,
        )}
      </ul>
      ${total > MAX_ATTACHMENTS_BYTES
        ? html`<p class="compose__warning">Attachments total ${formatSize(total)}. Many servers refuse messages over 25 MB.</p>`
        : ''}
    `;
  }

  function draw() {
    const { draft } = state;
    const accounts = store.get().accounts;
    const showCopies = draft.cc.length > 0 || draft.bcc.length > 0 || state.showCopies;
    render(
      element,
      html`
        <header class="app-bar">
          <button class="icon-button" type="button" data-action="back">${icon('close', 'Close and save draft')}</button>
          <h1 class="app-bar__title">${draft.replyOf ? 'Reply' : draft.forwardOf ? 'Forward' : 'New message'}</h1>
          <label class="icon-button compose__attach" title="Attach files">
            ${icon('attach', 'Attach files')}
            <input type="file" multiple hidden data-compose="attach" />
          </label>
          <button class="icon-button" type="button" data-compose="discard">${icon('delete', 'Discard draft')}</button>
          <button class="icon-button compose__send" type="button" data-compose="send">${icon('send', 'Send')}</button>
        </header>
        <form class="pane__body compose" novalidate autocomplete="off">
          <label class="compose__row">
            <span class="compose__label">From</span>
            ${accounts.length > 1
              ? html`<select name="accountId" class="compose__select">
                  ${accounts.map(
                    (a) => html`<option value="${a.id}" ${a.id === draft.accountId ? 'selected' : ''}>${a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>`,
                  )}
                </select>`
              : html`<span class="compose__from">${accountById(draft.accountId)?.email}</span>`}
          </label>
          <div class="compose__row">
            <span class="compose__label">To</span>
            <dm-address-input data-field="to" label="To"></dm-address-input>
            ${showCopies ? '' : html`<button class="text-button" type="button" data-compose="show-copies">Cc/Bcc</button>`}
          </div>
          ${showCopies
            ? html`
                <div class="compose__row"><span class="compose__label">Cc</span><dm-address-input data-field="cc" label="Cc"></dm-address-input></div>
                <div class="compose__row"><span class="compose__label">Bcc</span><dm-address-input data-field="bcc" label="Bcc"></dm-address-input></div>
              `
            : ''}
          <label class="compose__row">
            <span class="visually-hidden">Subject</span>
            <input class="compose__subject" name="subject" placeholder="Subject" value="${draft.subject}" autocapitalize="sentences" />
          </label>
          <div data-part="attachments">${attachmentList()}</div>
          <textarea class="compose__body" name="text" aria-label="Message" autocapitalize="sentences"></textarea>
        </form>
      `,
    );

    const suggest = (query) => searchContacts(db, query, { rank: rankContacts });
    for (const input of element.querySelectorAll('dm-address-input')) {
      input.suggest = suggest;
      input.addresses = draft[input.dataset.field];
    }
    const body = element.querySelector('.compose__body');
    // Set as a property: HTML drops a newline straight after <textarea>, and replies start with two.
    body.value = draft.text;
    // Replies start above the quote.
    if (draft.replyOf || draft.forwardOf) body.setSelectionRange(0, 0);
    const first = draft.to.length ? body : element.querySelector('dm-address-input input');
    requestAnimationFrame(() => first?.focus());
  }

  function readForm() {
    if (!state) return;
    for (const input of element.querySelectorAll('dm-address-input')) {
      input.flush();
      state.draft[input.dataset.field] = input.addresses;
    }
    const form = element.querySelector('form');
    if (!form) return;
    state.draft.subject = form.subject.value;
    state.draft.text = form.text.value;
    if (form.accountId) state.draft.accountId = form.accountId.value;
  }

  // --- Saving --------------------------------------------------------------------------------------------

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveLocal().catch(() => {}), AUTOSAVE_MS);
  }

  async function saveLocal() {
    if (!state) return;
    readForm();
    const account = accountById(state.draft.accountId);
    if (isBlankDraft(state.draft, account)) return;
    await saveDraft(db, { id: state.draftId, accountId: state.draft.accountId, data: state.draft, remoteUid: state.remoteUid });
  }

  /** Leaving the editor: keep the draft (locally and on the server), or drop it if blank or discarded. */
  async function close() {
    clearTimeout(autosaveTimer);
    if (!state) return;
    readForm();
    const closing = state;
    state = null;
    const account = accountById(closing.draft.accountId);
    const folder = account && draftsFolder(account);

    if (closing.discarding || isBlankDraft(closing.draft, account)) {
      await deleteDraft(db, closing.draftId);
      if (closing.remoteUid && folder) await mail.deleteMessages(account, folder, [closing.remoteUid]).catch(() => {});
      if (closing.discarding) snackbar.show('Draft discarded');
      return;
    }
    if (closing.sent) return;

    await saveDraft(db, { id: closing.draftId, accountId: closing.draft.accountId, data: closing.draft, remoteUid: closing.remoteUid });
    snackbar.show('Draft saved');
    if (!folder) return;
    try {
      const attachments = closing.draft.attachments.filter((a) => a.path && !a.path.startsWith('memory://'));
      const uid = await mail.saveDraft(account, toOutgoing({ ...closing.draft, attachments }, account), {
        draftsFolder: folder,
        replaceUid: closing.remoteUid,
      });
      await setDraftRemoteUid(db, closing.draftId, uid);
    } catch {
      // Kept locally; the next save tries the server again.
    }
  }

  // --- Sending --------------------------------------------------------------------------------------------

  async function send() {
    readForm();
    const problems = validateDraft(state.draft);
    if (problems.length) {
      snackbar.show(problems.join(' '));
      return;
    }
    const account = accountById(state.draft.accountId);
    const sendButton = element.querySelector('[data-compose=send]');
    sendButton.disabled = true;
    try {
      const attachments = await resolveAttachments(state.draft.attachments, async (from, filename) => {
        const message = await getMessage(db, from.id);
        const folder = folderOf(message);
        return (await mail.downloadAttachment(accountById(message.accountId), folder.path, message.uid, from.partId, filename)).path;
      });
      const draft = { ...state.draft, attachments };
      await saveDraft(db, { id: state.draftId, accountId: draft.accountId, data: draft, remoteUid: state.remoteUid });
      const outboxId = await outbox.queue({
        accountId: account.id,
        outgoing: toOutgoing(draft, account),
        replyOf: draft.replyOf,
        forwardOf: draft.forwardOf,
        draftId: state.draftId,
        remoteDraftUid: state.remoteUid,
      });
      const draftId = state.draftId;
      state.sent = true;
      router.back();
      snackbar.show('Sending…', {
        action: 'Undo',
        durationMs: 5000,
        onAction: async () => {
          if (await outbox.cancel(outboxId)) router.navigate({ name: 'compose', mode: 'draft', id: draftId });
          else snackbar.show('Already sent.');
        },
      });
    } catch (error) {
      sendButton.disabled = false;
      onError(error);
    }
  }

  // --- Events ---------------------------------------------------------------------------------------------

  element.addEventListener('input', () => state && scheduleAutosave());
  element.addEventListener('change', async (event) => {
    if (!state) return;
    const picker = event.target.closest('[data-compose=attach]');
    if (picker) {
      try {
        for (const file of picker.files) state.draft.attachments.push(await stageFile(file));
      } catch (error) {
        onError(error);
      }
      picker.value = '';
      render(element.querySelector('[data-part=attachments]'), attachmentList());
    }
    scheduleAutosave();
  });
  element.addEventListener('click', (event) => {
    const button = event.target.closest('[data-compose]');
    if (!button || !state) return;
    switch (button.dataset.compose) {
      case 'send':
        send();
        break;
      case 'discard':
        state.discarding = true;
        router.back();
        break;
      case 'show-copies':
        readForm();
        state.showCopies = true;
        draw();
        break;
      case 'remove-attachment':
        state.draft.attachments.splice(Number(button.dataset.index), 1);
        render(element.querySelector('[data-part=attachments]'), attachmentList());
        scheduleAutosave();
        break;
    }
  });

  return {
    async open(route) {
      const token = ++openToken;
      if (store.get().accounts.length === 0) {
        snackbar.show('Add an account first.');
        router.navigate({ name: 'accountSetup' }, { replace: true });
        return;
      }
      render(element, html`<div class="pane__body"><p class="message__loading compose__loading">Loading…</p></div>`);
      try {
        const next = await initialState(route);
        if (token !== openToken) return;
        state = next;
        draw();
      } catch (error) {
        onError(error);
        router.back();
      }
    },
    close: () => close().catch(onError),
  };
}

