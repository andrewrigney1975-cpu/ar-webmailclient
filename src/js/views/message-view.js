/**
 * Reading pane (PLAN.md §4.8). HTML mail is shown in an iframe sandboxed
 * without script permission ("allow-same-origin" only, so the app can size
 * the frame and handle link taps), with a strict CSP: nothing remote loads
 * unless the user allows images for this message or this sender.
 */
import { Capacitor } from '@capacitor/core';
import { html, icon, render } from '../html.js';
import { getMessage, saveBody } from '../db/repo-messages.js';
import { isTrustedSender, trustSender } from '../db/repo-senders.js';
import { buildFrameDocument, prepareHtml } from '../mail/html-content.js';
import { displayName, formatAddressList, formatFullDate, formatSize, htmlToText, snippetOf } from '../util/format.js';

const FILE_ICONS = [
  [/^image\//, 'image'],
  [/^/, 'file'],
];

export function createMessageView({ element, db, store, mail, actions, snackbar, onError, onClose, openExternal, dialogs }) {
  let route = null;
  let state = null; // { message, body, error, allowRemote, trusted, downloading }
  let loadId = 0;

  const accountOf = (m) => store.get().accounts.find((a) => a.id === m.accountId);
  const folderOf = (m) => store.get().folders.find((f) => f.id === m.folderId);

  async function load(id) {
    const token = ++loadId;
    const message = await getMessage(db, id);
    if (token !== loadId) return;
    if (!message) {
      state = null;
      draw();
      return;
    }

    const cached = message.bodyFetchedAt
      ? { text: message.bodyText, html: message.bodyHtml, attachments: message.attachments }
      : undefined;
    state = {
      message,
      body: cached,
      error: null,
      allowRemote: false,
      trusted: await isTrustedSender(db, message.from?.address),
      downloading: new Set(),
    };
    draw();

    if (!message.isRead) actions.markRead([message.id]).catch(() => {});
    if (cached) return;

    const account = accountOf(message);
    const folder = folderOf(message);
    if (!account || !folder) return;
    try {
      const body = await mail.fetchBody(account, folder.path, message.uid);
      const text = body.text ?? (body.html ? htmlToText(body.html) : '');
      await saveBody(db, id, { text: body.text, html: body.html, snippet: snippetOf(text), attachments: body.attachments });
      if (token !== loadId) return;
      state = { ...state, body };
    } catch (error) {
      if (token !== loadId) return;
      state = { ...state, error: error.message };
    }
    draw();
  }

  // --- Frame -------------------------------------------------------------------------------------

  /** Local URLs for inline (cid:) images; downloads them on Android. */
  async function inlineImages(message, attachments) {
    const map = new Map();
    const account = accountOf(message);
    const folder = folderOf(message);
    if (!Capacitor.isNativePlatform() || !account || !folder) return map;
    for (const a of attachments.filter((x) => x.inline && x.contentId && x.mimeType.startsWith('image/'))) {
      try {
        const { path } = await mail.downloadAttachment(account, folder.path, message.uid, a.partId, a.filename ?? a.contentId);
        map.set(a.contentId.toLowerCase(), Capacitor.convertFileSrc(path));
      } catch {
        // Missing inline images just don't show.
      }
    }
    return map;
  }

  async function mountFrame(frame, token) {
    const { message, body, allowRemote, trusted } = state;
    const prepared = prepareHtml(body.html, { inlineImages: await inlineImages(message, body.attachments ?? []) });
    if (token !== loadId) return;

    const showRemote = allowRemote || trusted;
    element.querySelector('[data-part=remote]').hidden = !prepared.hasRemoteContent || showRemote;
    frame.srcdoc = buildFrameDocument(prepared, { allowRemote: showRemote });
    frame.addEventListener('load', () => fitFrame(frame), { once: true });
  }

  /** Sizes the frame to its content, scaling down wide (fixed-width) emails to fit. */
  function fitFrame(frame) {
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => {
      const root = doc.documentElement;
      root.style.zoom = '';
      const available = frame.clientWidth;
      const needed = root.scrollWidth;
      if (needed > available + 1) root.style.zoom = String(available / needed);
      frame.style.height = `${Math.ceil(root.getBoundingClientRect().height * (Number(root.style.zoom) || 1))}px`;
    };
    fit();
    for (const img of doc.images) {
      if (!img.complete) img.addEventListener('load', fit, { once: true });
    }
    new ResizeObserver(fit).observe(frame);

    doc.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('href');
      if (/^https?:/i.test(href)) openExternal(href);
      else if (/^mailto:/i.test(href)) snackbar.show('Writing email isn’t available yet.');
    });
  }

  // --- Rendering ---------------------------------------------------------------------------------

  function toolbar(message) {
    const role = folderOf(message)?.role;
    const inTrash = role === 'trash' || role === 'junk';
    return html`
      <button class="icon-button app-bar__back" type="button" data-action="back">${icon('back', 'Back')}</button>
      <span class="app-bar__title"></span>
      ${role === 'archive' ? '' : html`<button class="icon-button" type="button" data-message="archive">${icon('archive', 'Archive')}</button>`}
      ${inTrash
        ? html`<button class="icon-button" type="button" data-message="delete-forever">${icon('delete-forever', 'Delete forever')}</button>`
        : html`<button class="icon-button" type="button" data-message="trash">${icon('delete', 'Delete')}</button>`}
      <button class="icon-button" type="button" data-message="unread">${icon('mail', 'Mark unread')}</button>
      <button class="icon-button" type="button" data-message="flag" aria-pressed="${String(message.isFlagged)}">
        ${icon(message.isFlagged ? 'star' : 'star-outline', message.isFlagged ? 'Remove flag' : 'Flag')}
      </button>
      <button class="icon-button" type="button" data-message="move">${icon('move', 'Move to folder')}</button>
    `;
  }

  function attachmentList(attachments) {
    const files = attachments.filter((a) => !a.inline);
    if (files.length === 0) return '';
    return html`
      <ul class="attachments" role="list">
        ${files.map((a) => {
          const iconName = FILE_ICONS.find(([pattern]) => pattern.test(a.mimeType))[1];
          const busy = state.downloading.has(a.partId);
          return html`<li class="attachment">
            <button class="attachment__open" type="button" data-attachment="open" data-part-id="${a.partId}" ${busy ? 'disabled' : ''}>
              ${icon(iconName)}
              <span class="attachment__name">${a.filename ?? 'Attachment'}</span>
              <span class="attachment__size">${busy ? 'Downloading…' : formatSize(a.size)}</span>
            </button>
            <button class="icon-button" type="button" data-attachment="share" data-part-id="${a.partId}" ${busy ? 'disabled' : ''}>
              ${icon('share', `Share ${a.filename ?? 'attachment'}`)}
            </button>
          </li>`;
        })}
      </ul>
    `;
  }

  function content() {
    const { body, error } = state;
    if (error) return html`<div class="banner banner--error" role="status">${icon('error')}<p>${error}</p></div>`;
    if (body === undefined) return html`<p class="message__loading">Loading…</p>`;
    if (body.html) return html`<iframe class="message__frame" sandbox="allow-same-origin" title="Message content"></iframe>`;
    return html`<div class="message__text">${body.text || '(This message has no text.)'}</div>`;
  }

  function draw() {
    if (!route?.threadId || !state) {
      render(
        element,
        html`<div class="pane__body"><dm-empty-state icon="mail" heading="No conversation selected"
          message="Choose a conversation from the list to read it here."></dm-empty-state></div>`,
      );
      return;
    }
    const { message, body } = state;
    render(
      element,
      html`
        <header class="app-bar" data-part="toolbar">${toolbar(message)}</header>
        <div class="pane__body">
          <article class="message" style="--row-accent: ${accountOf(message)?.accentColor ?? 'var(--accent)'}">
            <h2 class="message__subject">${message.subject || '(no subject)'}</h2>
            <dl class="message__meta">
              <dt>From</dt><dd>${message.from ? formatAddressList([message.from]) : displayName(null)}</dd>
              ${message.to.length ? html`<dt>To</dt><dd>${formatAddressList(message.to)}</dd>` : ''}
              ${message.cc.length ? html`<dt>Cc</dt><dd>${formatAddressList(message.cc)}</dd>` : ''}
              <dt>Date</dt><dd>${formatFullDate(message.dateSent ?? message.dateReceived)}</dd>
            </dl>
            <div class="banner banner--info message__remote" data-part="remote" hidden>
              ${icon('image')}
              <div>
                <p>Images are hidden to protect your privacy.</p>
                <button class="text-button" type="button" data-message="show-images">Show images</button>
                ${message.from ? html`<button class="text-button" type="button" data-message="trust-sender">Always from this sender</button>` : ''}
              </div>
            </div>
            ${content()}
            <div data-part="attachments">${body ? attachmentList(body.attachments ?? []) : ''}</div>
          </article>
        </div>
      `,
    );
    const frame = element.querySelector('.message__frame');
    if (frame) mountFrame(frame, loadId);
  }

  function drawToolbar() {
    const part = element.querySelector('[data-part=toolbar]');
    if (part) render(part, toolbar(state.message));
  }

  function drawAttachments() {
    const part = element.querySelector('[data-part=attachments]');
    if (part && state.body) render(part, attachmentList(state.body.attachments ?? []));
  }

  // --- Events --------------------------------------------------------------------------------------

  async function openAttachment(partId, share) {
    const { message, body } = state;
    const attachment = body.attachments.find((a) => a.partId === partId);
    const account = accountOf(message);
    const folder = folderOf(message);
    if (!attachment || !account || !folder) return;
    state.downloading.add(partId);
    drawAttachments();
    try {
      const { path } = await mail.downloadAttachment(account, folder.path, message.uid, partId, attachment.filename ?? 'attachment');
      if (share) await mail.shareFile(path, attachment.mimeType, attachment.filename);
      else await mail.openFile(path, attachment.mimeType);
    } catch (error) {
      onError(error);
    } finally {
      state.downloading.delete(partId);
      drawAttachments();
    }
  }

  async function messageAction(action) {
    const { message } = state;
    try {
      switch (action) {
        case 'archive':
        case 'trash': {
          onClose();
          const token = await (action === 'archive' ? actions.archive([message.id]) : actions.trash([message.id]));
          if (token) {
            snackbar.show(action === 'archive' ? 'Message archived' : 'Message moved to Trash', {
              action: token.undoable ? 'Undo' : undefined,
              onAction: () => actions.undo(token).catch(onError),
            });
          }
          break;
        }
        case 'delete-forever':
          if (await dialogs.confirmDeleteForever(1)) {
            onClose();
            await actions.deleteForever([message.id]);
          }
          break;
        case 'unread':
          onClose();
          await actions.markRead([message.id], false);
          break;
        case 'flag':
          await actions.setFlagged([message.id], !message.isFlagged);
          state = { ...state, message: { ...message, isFlagged: !message.isFlagged } };
          drawToolbar();
          break;
        case 'move': {
          const folder = await dialogs.pickFolder([message]);
          if (!folder) return;
          onClose();
          const token = await actions.move([message.id], folder.id);
          if (token) {
            snackbar.show(`Message moved to ${folder.name}`, {
              action: token.undoable ? 'Undo' : undefined,
              onAction: () => actions.undo(token).catch(onError),
            });
          }
          break;
        }
        case 'show-images':
          state = { ...state, allowRemote: true };
          draw();
          break;
        case 'trust-sender':
          await trustSender(db, message.from.address);
          state = { ...state, trusted: true };
          draw();
          break;
      }
    } catch (error) {
      onError(error);
    }
  }

  element.addEventListener('click', (event) => {
    const messageButton = event.target.closest('[data-message]');
    if (messageButton && state) messageAction(messageButton.dataset.message);
    const attachmentButton = event.target.closest('[data-attachment]');
    if (attachmentButton && state?.body) {
      openAttachment(attachmentButton.dataset.partId, attachmentButton.dataset.attachment === 'share');
    }
  });

  return {
    show(next) {
      const changed = next.threadId !== route?.threadId;
      route = next;
      if (!changed) return;
      if (next.threadId) load(Number(next.threadId));
      else {
        loadId += 1;
        state = null;
        draw();
      }
    },
    /** The cached message may have changed (flags); refresh the header without refetching. */
    async dataChanged() {
      if (!state) return;
      const message = await getMessage(db, state.message.id);
      if (!message) return;
      if (message.isFlagged !== state.message.isFlagged) {
        state = { ...state, message: { ...state.message, isFlagged: message.isFlagged } };
        drawToolbar();
      }
    },
  };
}
