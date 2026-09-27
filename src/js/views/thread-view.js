/**
 * Reading pane: a conversation as a column of message cards (PLAN.md §4.2).
 * Unread messages and the newest one start expanded; the rest show a
 * one-line summary. Quoted history and signatures are folded.
 *
 * HTML bodies are shown in an iframe sandboxed without script permission
 * ("allow-same-origin" only, so the app can size the frame and handle link
 * taps), with a CSP that blocks remote content until the user allows it for
 * the message or the sender (PLAN.md §4.8).
 */
import { Capacitor } from '@capacitor/core';
import { html, icon, render } from '../html.js';
import { saveBody } from '../db/repo-messages.js';
import { isTrustedSender, trustSender } from '../db/repo-senders.js';
import { messageIdsInThreads, threadMessages, unreadIdsInThreads } from '../db/repo-threads.js';
import { buildFrameDocument, prepareHtml, splitPlainText } from '../mail/html-content.js';
import { UNIFIED_INBOX } from '../router.js';
import {
  displayName,
  formatAddressList,
  formatFullDate,
  formatListDate,
  formatSize,
  htmlToText,
  snippetOf,
} from '../util/format.js';

function initialOf(person) {
  const text = displayName(person).replace(/^[^\p{L}\p{N}]+/u, '');
  return (text[0] ?? '?').toUpperCase();
}

export function createThreadView({ element, db, store, mail, actions, snackbar, onError, onClose, openExternal, dialogs }) {
  let route = null;
  let loadId = 0;
  // { key, messages, expanded: Set<id>, bodies: Map<id, { body?, error? }>, allowRemote: Set<id>,
  //   trusted: Set<address>, downloading: Map<id, Set<partId>>, inlineCache: Map<id, Map> }
  let state = null;

  const accountOf = (m) => store.get().accounts.find((a) => a.id === m.accountId);
  const folderOf = (m) => store.get().folders.find((f) => f.id === m.folderId);
  const scope = () =>
    route.folderId === UNIFIED_INBOX ? { unified: true } : { folderId: Number(route.folderId) };
  const viewingRole = () => store.get().folders.find((f) => String(f.id) === route.folderId)?.role ?? null;
  const isMe = (person) => store.get().accounts.some((a) => a.email === person?.address?.toLowerCase());

  // --- Loading -----------------------------------------------------------------------------------

  async function load(key) {
    const token = ++loadId;
    const role = viewingRole();
    const messages = await threadMessages(db, key, { includeHidden: role === 'trash' || role === 'junk' });
    if (token !== loadId) return;
    if (messages.length === 0) {
      state = null;
      draw();
      return;
    }

    const newest = messages.at(-1);
    const expanded = new Set(messages.filter((m) => !m.isRead).map((m) => m.id));
    expanded.add(newest.id);
    const trusted = new Set();
    for (const m of messages) {
      if (m.from && (await isTrustedSender(db, m.from.address))) trusted.add(m.from.address);
    }

    state = {
      key,
      messages,
      expanded,
      bodies: new Map(
        messages
          .filter((m) => m.bodyFetchedAt)
          .map((m) => [m.id, { body: { text: m.bodyText, html: m.bodyHtml, attachments: m.attachments } }]),
      ),
      allowRemote: new Set(),
      trusted,
      downloading: new Map(),
      inlineCache: new Map(),
    };
    draw();

    unreadIdsInThreads(db, [key])
      .then((ids) => ids.length && actions.markRead(ids))
      .catch(() => {});
    for (const id of expanded) fetchBody(id, token);
  }

  async function fetchBody(id, token = loadId) {
    if (state.bodies.get(id)?.body) return;
    const message = state.messages.find((m) => m.id === id);
    const account = accountOf(message);
    const folder = folderOf(message);
    if (!account || !folder) return;
    try {
      const body = await mail.fetchBody(account, folder.path, message.uid);
      const text = body.text ?? (body.html ? htmlToText(body.html) : '');
      await saveBody(db, id, { text: body.text, html: body.html, snippet: snippetOf(text), attachments: body.attachments });
      if (token !== loadId) return;
      message.snippet = snippetOf(text);
      state.bodies.set(id, { body });
    } catch (error) {
      if (token !== loadId) return;
      state.bodies.set(id, { error: error.message });
    }
    drawCard(id);
  }

  // --- Rendering -----------------------------------------------------------------------------------

  function toolbar() {
    const role = viewingRole();
    const inTrash = role === 'trash' || role === 'junk';
    const flagged = state.messages.some((m) => m.isFlagged);
    return html`
      <button class="icon-button app-bar__back" type="button" data-action="back">${icon('back', 'Back')}</button>
      <span class="app-bar__title"></span>
      ${role === 'archive' ? '' : html`<button class="icon-button" type="button" data-thread="archive">${icon('archive', 'Archive')}</button>`}
      ${inTrash
        ? html`<button class="icon-button" type="button" data-thread="delete-forever">${icon('delete-forever', 'Delete forever')}</button>`
        : html`<button class="icon-button" type="button" data-thread="trash">${icon('delete', 'Delete')}</button>`}
      <button class="icon-button" type="button" data-thread="unread">${icon('mail', 'Mark unread')}</button>
      <button class="icon-button" type="button" data-thread="flag" aria-pressed="${String(flagged)}">
        ${icon(flagged ? 'star' : 'star-outline', flagged ? 'Remove flag' : 'Flag')}
      </button>
      <button class="icon-button" type="button" data-thread="move">${icon('move', 'Move to folder')}</button>
    `;
  }

  function attachmentList(message, attachments) {
    const files = attachments.filter((a) => !a.inline);
    if (files.length === 0) return '';
    const busy = state.downloading.get(message.id) ?? new Set();
    return html`
      <ul class="attachments" role="list">
        ${files.map(
          (a) => html`<li class="attachment">
            <button class="attachment__open" type="button" data-attachment="open" data-part-id="${a.partId}" ${busy.has(a.partId) ? 'disabled' : ''}>
              ${icon(a.mimeType.startsWith('image/') ? 'image' : 'file')}
              <span class="attachment__name">${a.filename ?? 'Attachment'}</span>
              <span class="attachment__size">${busy.has(a.partId) ? 'Downloading…' : formatSize(a.size)}</span>
            </button>
            <button class="icon-button" type="button" data-attachment="share" data-part-id="${a.partId}" ${busy.has(a.partId) ? 'disabled' : ''}>
              ${icon('share', `Share ${a.filename ?? 'attachment'}`)}
            </button>
          </li>`,
        )}
      </ul>
    `;
  }

  function plainBody(text) {
    const { body, quote, signature } = splitPlainText(text);
    return html`
      <div class="message__text">${body || '(This message has no text.)'}</div>
      ${signature ? html`<details class="message__fold"><summary>•••</summary><div class="message__text">${signature}</div></details>` : ''}
      ${quote ? html`<details class="message__fold"><summary>Show quoted text</summary><div class="message__text message__text--quote">${quote}</div></details>` : ''}
    `;
  }

  function cardContent(message) {
    const accent = accountOf(message)?.accentColor ?? 'var(--accent)';
    const sender = isMe(message.from) ? 'Me' : displayName(message.from);

    if (!state.expanded.has(message.id)) {
      return html`
        <button class="card__summary" type="button" data-card="expand" style="--row-accent: ${accent}">
          <span class="message-row__avatar" aria-hidden="true">${initialOf(message.from)}</span>
          <span class="card__from">${sender}</span>
          <span class="card__date">${formatListDate(message.dateSent ?? message.dateReceived)}</span>
          <span class="card__snippet">${message.snippet ?? ''}</span>
        </button>
      `;
    }

    const loaded = state.bodies.get(message.id);
    let body;
    if (loaded?.error) body = html`<div class="banner banner--error" role="status">${icon('error')}<p>${loaded.error}</p></div>`;
    else if (!loaded?.body) body = html`<p class="message__loading">Loading…</p>`;
    else if (loaded.body.html) body = html`<iframe class="message__frame" sandbox="allow-same-origin" title="Message from ${sender}"></iframe>`;
    else body = plainBody(loaded.body.text);

    return html`
      <header class="card__header" data-card="collapse" style="--row-accent: ${accent}">
        <span class="message-row__avatar" aria-hidden="true">${initialOf(message.from)}</span>
        <div class="card__who">
          <p class="card__from">${message.from ? formatAddressList([message.from]) : displayName(null)}</p>
          <p class="card__to">
            ${message.to.length ? html`To ${message.to.map((p) => (isMe(p) ? 'me' : displayName(p))).join(', ')}` : ''}
            ${message.cc.length ? html` · Cc ${message.cc.map(displayName).join(', ')}` : ''}
          </p>
        </div>
        <time class="card__date">${formatFullDate(message.dateSent ?? message.dateReceived)}</time>
      </header>
      <div class="banner banner--info message__remote" data-part="remote" hidden>
        ${icon('image')}
        <div>
          <p>Images are hidden to protect your privacy.</p>
          <button class="text-button" type="button" data-card="show-images">Show images</button>
          ${message.from ? html`<button class="text-button" type="button" data-card="trust-sender">Always from this sender</button>` : ''}
        </div>
      </div>
      ${body}
      <div data-part="attachments">${loaded?.body ? attachmentList(message, loaded.body.attachments ?? []) : ''}</div>
    `;
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
    const newest = state.messages.at(-1);
    render(
      element,
      html`
        <header class="app-bar" data-part="toolbar">${toolbar()}</header>
        <div class="pane__body">
          <div class="thread">
            <h2 class="thread__subject">
              ${newest.subject || '(no subject)'}
              ${state.messages.length > 1 ? html`<span class="thread__count">${state.messages.length}</span>` : ''}
            </h2>
            ${state.messages.map(
              (m) => html`<article class="card${state.expanded.has(m.id) ? ' card--expanded' : ''}" data-card-id="${m.id}">
                ${cardContent(m)}
              </article>`,
            )}
          </div>
        </div>
      `,
    );
    for (const m of state.messages) mountFrame(m.id);
  }

  function drawCard(id) {
    const card = element.querySelector(`[data-card-id="${id}"]`);
    const message = state?.messages.find((m) => m.id === id);
    if (!card || !message) return;
    card.classList.toggle('card--expanded', state.expanded.has(id));
    render(card, cardContent(message));
    mountFrame(id);
  }

  function drawToolbar() {
    const part = element.querySelector('[data-part=toolbar]');
    if (part && state) render(part, toolbar());
  }

  // --- Frames ----------------------------------------------------------------------------------------

  /** Local URLs for inline (cid:) images, downloaded once per message on Android. */
  async function inlineImages(message, attachments) {
    if (state.inlineCache.has(message.id)) return state.inlineCache.get(message.id);
    const map = new Map();
    const account = accountOf(message);
    const folder = folderOf(message);
    if (Capacitor.isNativePlatform() && account && folder) {
      for (const a of attachments.filter((x) => x.inline && x.contentId && x.mimeType.startsWith('image/'))) {
        try {
          const { path } = await mail.downloadAttachment(account, folder.path, message.uid, a.partId, a.filename ?? a.contentId);
          map.set(a.contentId.toLowerCase(), Capacitor.convertFileSrc(path));
        } catch {
          // A missing inline image just doesn't show.
        }
      }
    }
    state.inlineCache.set(message.id, map);
    return map;
  }

  async function mountFrame(id) {
    const card = element.querySelector(`[data-card-id="${id}"]`);
    const frame = card?.querySelector('.message__frame');
    const loaded = state.bodies.get(id);
    if (!frame || !loaded?.body?.html) return;
    const message = state.messages.find((m) => m.id === id);
    const token = loadId;

    const prepared = prepareHtml(loaded.body.html, {
      inlineImages: await inlineImages(message, loaded.body.attachments ?? []),
      foldQuotes: true,
    });
    if (token !== loadId || !frame.isConnected) return;

    const showRemote = state.allowRemote.has(id) || state.trusted.has(message.from?.address);
    card.querySelector('[data-part=remote]').hidden = !prepared.hasRemoteContent || showRemote;
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
    doc.addEventListener('toggle', fit, true); // folded quotes opening and closing
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

  // --- Actions -----------------------------------------------------------------------------------------

  async function openAttachment(message, partId, share) {
    const attachment = state.bodies.get(message.id)?.body?.attachments.find((a) => a.partId === partId);
    const account = accountOf(message);
    const folder = folderOf(message);
    if (!attachment || !account || !folder) return;
    const busy = state.downloading.get(message.id) ?? new Set();
    state.downloading.set(message.id, busy);
    const redraw = () => {
      const part = element.querySelector(`[data-card-id="${message.id}"] [data-part=attachments]`);
      if (part) render(part, attachmentList(message, state.bodies.get(message.id).body.attachments ?? []));
    };
    busy.add(partId);
    redraw();
    try {
      const { path } = await mail.downloadAttachment(account, folder.path, message.uid, partId, attachment.filename ?? 'attachment');
      if (share) await mail.shareFile(path, attachment.mimeType, attachment.filename);
      else await mail.openFile(path, attachment.mimeType);
    } catch (error) {
      onError(error);
    } finally {
      busy.delete(partId);
      redraw();
    }
  }

  function moved(token, text) {
    if (!token) return;
    snackbar.show(text, {
      action: token.undoable ? 'Undo' : undefined,
      onAction: () => actions.undo(token).catch(onError),
    });
  }

  async function threadAction(action) {
    const newest = state.messages.at(-1);
    const ids = () => messageIdsInThreads(db, [state.key], scope());
    try {
      switch (action) {
        case 'archive': {
          const messageIds = await ids();
          onClose();
          moved(await actions.archive(messageIds), 'Conversation archived');
          break;
        }
        case 'trash': {
          const messageIds = await ids();
          onClose();
          moved(await actions.trash(messageIds), 'Conversation moved to Trash');
          break;
        }
        case 'delete-forever': {
          const messageIds = await ids();
          if (await dialogs.confirmDeleteForever(messageIds.length)) {
            onClose();
            await actions.deleteForever(messageIds);
          }
          break;
        }
        case 'unread':
          onClose();
          await actions.markRead([newest.id], false);
          break;
        case 'flag': {
          const flagged = state.messages.some((m) => m.isFlagged);
          const targets = flagged ? state.messages.filter((m) => m.isFlagged).map((m) => m.id) : [newest.id];
          await actions.setFlagged(targets, !flagged);
          for (const m of state.messages) if (targets.includes(m.id)) m.isFlagged = !flagged;
          drawToolbar();
          break;
        }
        case 'move': {
          const messageIds = await ids();
          const folder = await dialogs.pickFolder(state.messages.filter((m) => messageIds.includes(m.id)));
          if (!folder) return;
          onClose();
          moved(await actions.move(messageIds, folder.id), `Conversation moved to ${folder.name}`);
          break;
        }
      }
    } catch (error) {
      onError(error);
    }
  }

  async function cardAction(action, message) {
    switch (action) {
      case 'expand':
        state.expanded.add(message.id);
        drawCard(message.id);
        fetchBody(message.id);
        break;
      case 'collapse':
        // Keep the newest message open so the conversation never looks empty.
        if (message.id === state.messages.at(-1).id) return;
        state.expanded.delete(message.id);
        drawCard(message.id);
        break;
      case 'show-images':
        state.allowRemote.add(message.id);
        drawCard(message.id);
        break;
      case 'trust-sender':
        await trustSender(db, message.from.address);
        state.trusted.add(message.from.address);
        for (const m of state.messages) if (m.from?.address === message.from.address) drawCard(m.id);
        break;
    }
  }

  element.addEventListener('click', (event) => {
    if (!state) return;
    const threadButton = event.target.closest('[data-thread]');
    if (threadButton) {
      threadAction(threadButton.dataset.thread);
      return;
    }
    const card = event.target.closest('[data-card-id]');
    const message = card && state.messages.find((m) => String(m.id) === card.dataset.cardId);
    if (!message) return;
    const cardButton = event.target.closest('[data-card]');
    if (cardButton) {
      cardAction(cardButton.dataset.card, message);
      return;
    }
    const attachmentButton = event.target.closest('[data-attachment]');
    if (attachmentButton) openAttachment(message, attachmentButton.dataset.partId, attachmentButton.dataset.attachment === 'share');
  });

  return {
    show(next) {
      const changed = next.threadId !== route?.threadId || next.folderId !== route?.folderId;
      route = next;
      if (!changed) return;
      if (next.threadId) load(next.threadId);
      else {
        loadId += 1;
        state = null;
        draw();
      }
    },
    /** Cached mail changed: keep flags in the toolbar current without reloading bodies. */
    async dataChanged() {
      if (!state) return;
      const fresh = await threadMessages(db, state.key, { includeHidden: true });
      let changed = false;
      for (const m of state.messages) {
        const f = fresh.find((x) => x.id === m.id);
        if (f && f.isFlagged !== m.isFlagged) {
          m.isFlagged = f.isFlagged;
          changed = true;
        }
      }
      if (changed) drawToolbar();
    },
  };
}
