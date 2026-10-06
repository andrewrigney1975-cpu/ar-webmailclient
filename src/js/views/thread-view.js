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
import { blockFor, domainOf } from '../mail/blocking.js';
import { messageIdsInThreads, threadMessages, unreadIdsInThreads } from '../db/repo-threads.js';
import { buildFrameDocument, prepareHtml, splitPlainText } from '../mail/html-content.js';
import { SEARCH, UNIFIED_INBOX } from '../router.js';
import { dismissSuggestion, eventFromSuggestion, exportEvent, suggestionsFor } from '../calendar/calendar.js';
import { editEvent } from './components/event-editor.js';
import { chooseFromSheet } from './components/overlays.js';
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

export function createThreadView({
  element,
  db,
  store,
  mail,
  actions,
  snackbar,
  onError,
  onClose,
  onCompose,
  openExternal,
  dialogs,
  blocking,
  router,
}) {
  let route = null;
  let loadId = 0;
  // { key, messages, expanded: Set<id>, bodies: Map<id, { body?, error? }>, allowRemote: Set<id>,
  //   trusted: Set<address>, downloading: Map<id, Set<partId>>, inlineCache: Map<id, Map> }
  let state = null;

  const accountOf = (m) => store.get().accounts.find((a) => a.id === m.accountId);
  const folderOf = (m) => store.get().folders.find((f) => f.id === m.folderId);
  function scope() {
    if (route.folderId === UNIFIED_INBOX) return { unified: true };
    if (route.folderId === SEARCH) {
      // From search results: act on the conversation where its newest received message is.
      const outgoing = new Set(['sent', 'drafts']);
      const received = state.messages.filter((m) => !outgoing.has(folderOf(m)?.role));
      return { folderId: (received.at(-1) ?? state.messages.at(-1)).folderId };
    }
    return { folderId: Number(route.folderId) };
  }
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
      suggestions: new Map(),
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
      // body_text doubles as the search index text, so HTML-only mail stores its text too.
      await saveBody(db, id, { text, html: body.html, snippet: snippetOf(text), attachments: body.attachments });
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
      <div class="card__actions">
        ${folderOf(message)?.role === 'drafts'
          ? html`<button class="text-button" type="button" data-card="edit-draft">${icon('edit')} Edit draft</button>`
          : html`
              <button class="text-button" type="button" data-card="reply">${icon('reply')} Reply</button>
              ${message.to.length + message.cc.length > 1
                ? html`<button class="text-button" type="button" data-card="replyall">${icon('reply-all')} Reply all</button>`
                : ''}
              <button class="text-button" type="button" data-card="forward">${icon('forward')} Forward</button>
              ${message.from && !isMe(message.from)
                ? html`<button class="text-button" type="button" data-card="block">${icon('block')} ${blockFor(message.from.address, store.get().blocked) ? 'Unblock' : 'Block'}</button>`
                : ''}
            `}
      </div>
      <div class="banner banner--info message__remote" data-part="remote" hidden>
        ${icon('image')}
        <div>
          <p>Images are hidden to protect your privacy.</p>
          <button class="text-button" type="button" data-card="show-images">Show images</button>
          ${message.from ? html`<button class="text-button" type="button" data-card="trust-sender">Always from this sender</button>` : ''}
        </div>
      </div>
      <div data-part="dates"></div>
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
    for (const m of state.messages) {
      mountFrame(m.id);
      fillSuggestions(m.id);
    }
  }

  function drawCard(id) {
    const card = element.querySelector(`[data-card-id="${id}"]`);
    const message = state?.messages.find((m) => m.id === id);
    if (!card || !message) return;
    card.classList.toggle('card--expanded', state.expanded.has(id));
    render(card, cardContent(message));
    mountFrame(id);
    fillSuggestions(id);
  }

  // --- Calendar suggestions (PLAN.md §4.7) ----------------------------------------------------------------

  function formatWhen(suggestion) {
    const day = new Date(suggestion.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (suggestion.allDay) return day;
    return `${day}, ${new Date(suggestion.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }

  async function fillSuggestions(id) {
    const message = state?.messages.find((m) => m.id === id);
    const loaded = state?.bodies.get(id)?.body;
    if (!message || !loaded || !state.expanded.has(id)) return;
    const text = loaded.text ?? (loaded.html ? htmlToText(loaded.html) : '');
    const suggestions = (await suggestionsFor(db, message, text)).slice(0, 2);
    state.suggestions.set(id, suggestions);
    const slot = element.querySelector(`[data-card-id="${id}"] [data-part=dates]`);
    if (!slot) return;
    render(
      slot,
      html`${suggestions.map(
        (s, index) => html`<div class="date-suggestion">
          ${icon('event')}
          <div class="date-suggestion__text">
            <strong>${formatWhen(s)}</strong>
            <span>${s.title}</span>
          </div>
          <button class="text-button" type="button" data-card="add-event" data-index="${index}">Add to calendar</button>
          <button class="icon-button" type="button" data-card="dismiss-date" data-index="${index}">${icon('close', 'Dismiss')}</button>
        </div>`,
      )}`,
    );
  }

  async function addEvent(message, index) {
    const suggestion = state.suggestions.get(message.id)?.[index];
    if (!suggestion) return;
    const result = await editEvent(router, eventFromSuggestion(suggestion, message));
    if (!result) return;
    try {
      const done = await exportEvent(result.event, result.action, { mail });
      if (done === 'save') snackbar.show('Saved to Downloads.');
    } catch (error) {
      onError(error);
    }
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
    const { settings, colorScheme } = store.get();
    const dark = settings.darkMessages && colorScheme === 'dark';
    frame.classList.toggle('message__frame--dark', dark);
    frame.srcdoc = buildFrameDocument(prepared, { allowRemote: showRemote, dark });
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
      else if (/^mailto:/i.test(href)) onCompose({ name: 'compose', mode: 'mailto', id: encodeURIComponent(href) });
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

  /** Block sender / Block sender's domain, or Unblock if either already covers this sender. */
  async function blockOrUnblock(message) {
    const address = message.from.address.toLowerCase();
    const existing = blockFor(address, store.get().blocked);
    if (existing) {
      await blocking.unblock(existing.kind, existing.value);
      snackbar.show(`Unblocked ${existing.kind === 'domain' ? existing.value : address}`);
      drawCard(message.id);
      return;
    }
    const domain = domainOf(address);
    const choice = await chooseFromSheet(router, {
      title: `Block ${displayName(message.from)}?`,
      items: [
        { value: { kind: 'address', value: address }, label: `Block sender (${address})`, icon: 'block' },
        ...(domain ? [{ value: { kind: 'domain', value: domain }, label: `Block sender’s domain (anyone at ${domain})`, icon: 'block' }] : []),
      ],
    });
    if (!choice) return;
    const moved = await blocking.block(choice.kind, choice.value);
    snackbar.show(
      `Blocked ${choice.value}. ${moved ? `${moved} ${moved === 1 ? 'message' : 'messages'} moved to Trash; new` : 'New'} mail goes straight to Trash.`,
    );
    if (moved && !state?.messages.some((m) => !blockFor(m.from?.address, store.get().blocked))) onClose();
    else if (state) drawCard(message.id);
  }

  async function cardAction(action, message, button) {
    switch (action) {
      case 'add-event':
        addEvent(message, Number(button.dataset.index));
        break;
      case 'dismiss-date': {
        const suggestion = state.suggestions.get(message.id)?.[Number(button.dataset.index)];
        if (suggestion) await dismissSuggestion(db, message.id, suggestion.start);
        fillSuggestions(message.id);
        break;
      }
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
      case 'reply':
      case 'replyall':
      case 'forward':
        onCompose({ name: 'compose', mode: action, id: String(message.id) });
        break;
      case 'edit-draft':
        onCompose({ name: 'compose', mode: 'draft', id: `msg:${message.id}` });
        break;
      case 'block':
        await blockOrUnblock(message).catch(onError);
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
      cardAction(cardButton.dataset.card, message, cardButton);
      return;
    }
    const attachmentButton = event.target.closest('[data-attachment]');
    if (attachmentButton) openAttachment(message, attachmentButton.dataset.partId, attachmentButton.dataset.attachment === 'share');
  });

  return {
    /** Keyboard shortcuts on the open conversation. Returns false if none is open. */
    shortcut(action) {
      if (!state) return false;
      if (['archive', 'trash', 'unread', 'flag'].includes(action)) {
        threadAction(action);
        return true;
      }
      if (['reply', 'replyall', 'forward'].includes(action)) {
        const outgoing = new Set(['sent', 'drafts']);
        const target = state.messages.filter((m) => !outgoing.has(folderOf(m)?.role)).at(-1) ?? state.messages.at(-1);
        onCompose({ name: 'compose', mode: action, id: String(target.id) });
        return true;
      }
      return false;
    },

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
