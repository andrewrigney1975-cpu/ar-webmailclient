/**
 * The message list pane: app bar (or selection bar), status banners,
 * pull-to-refresh, and a virtualised list with swipe and long-press.
 *
 * Rows are conversations when threading is on, otherwise single messages.
 * Either way a row's `id` is a conversation key ("m:<id>" for a single
 * message), which is also the route's threadId; actions turn keys into the
 * message IDs in the current folder.
 */
import { html, icon, markup, render } from '../html.js';
import { buildHash, UNIFIED_INBOX } from '../router.js';
import { countMessages, listMessages } from '../db/repo-messages.js';
import { countThreads, listThreads, messageIdsInThreads, unreadIdsInThreads } from '../db/repo-threads.js';
import { displayName, formatListDate } from '../util/format.js';
import { VirtualList } from './components/virtual-list.js';
import { attachPullToRefresh, attachRowGestures } from './components/gestures.js';

const SWIPE_LABELS = { archive: 'Archive', trash: 'Delete' };

function initialOf(person) {
  const text = displayName(person).replace(/^[^\p{L}\p{N}]+/u, '');
  return (text[0] ?? '?').toUpperCase();
}

export function createMailboxView({ element, db, store, router, actions, syncManager, snackbar, onError, onOutboxAction }) {
  render(
    element,
    html`
      <header class="app-bar" data-part="bar"></header>
      <div data-part="banners"></div>
      <div class="pane__body mailbox__body" data-part="body">
        <div class="pull-indicator" hidden>${icon('refresh')}</div>
        <div class="mailbox__empty" data-part="empty"></div>
      </div>
      <a class="fab" href="#/compose" data-part="compose">${icon('edit')}<span>Compose</span></a>
    `,
  );
  const bar = element.querySelector('[data-part=bar]');
  const banners = element.querySelector('[data-part=banners]');
  const body = element.querySelector('[data-part=body]');
  const empty = element.querySelector('[data-part=empty]');

  let route = null;
  let selection = new Set();
  let unregisterSelection = null;

  const folderOf = (message) => store.get().folders.find((f) => f.id === message.folderId);
  const accountOf = (message) => store.get().accounts.find((a) => a.id === message.accountId);
  const query = () => (route.folderId === UNIFIED_INBOX ? { unified: true } : { folderId: Number(route.folderId) });
  const threading = () => store.get().settings.threading;
  const isMe = (person) => store.get().accounts.some((a) => a.email === person?.address?.toLowerCase());

  function asRow(message) {
    return { ...message, id: `m:${message.id}`, messageId: message.id, thread: null };
  }

  async function fetchPage(offset, limit) {
    if (threading()) return listThreads(db, { ...query(), offset, limit });
    return (await listMessages(db, { ...query(), offset, limit })).map(asRow);
  }

  /** Message IDs in the current folder for these row keys. */
  async function messageIds(keys) {
    const single = keys.filter((k) => k.startsWith('m:')).map((k) => Number(k.slice(2)));
    const threads = keys.filter((k) => !k.startsWith('m:'));
    return [...single, ...(await messageIdsInThreads(db, threads, query()))];
  }

  function participants(row) {
    const people = row.thread?.participants ?? [];
    if (people.length === 0) return displayName(row.from);
    const names = people.map((p) => (isMe(p) ? 'me' : displayName(p).split(/[\s@]/)[0]));
    return names.length > 3 ? `${names[0]} … ${names.slice(-2).join(', ')}` : names.join(', ');
  }

  function renderRow(m) {
    const folder = folderOf(m);
    const outgoing = folder?.role === 'sent' || folder?.role === 'drafts';
    const who = outgoing ? `To: ${m.to.map(displayName).join(', ') || '(no recipients)'}` : participants(m);
    const count = m.thread?.count > 1 ? m.thread.count : 0;
    const selected = selection.has(m.id);
    const classes = [
      'message-row',
      m.isRead ? '' : 'message-row--unread',
      String(m.id) === route.threadId ? 'message-row--current' : '',
      selected ? 'message-row--selected' : '',
    ].join(' ');
    return markup(html`
      <div class="vlist__action vlist__action--right">${icon('archive')}<span>${SWIPE_LABELS.archive}</span></div>
      <div class="vlist__action vlist__action--left"><span>${SWIPE_LABELS.trash}</span>${icon('delete')}</div>
      <a class="${classes}" href="${buildHash({ ...route, threadId: String(m.id) })}"
         style="--row-accent: ${accountOf(m)?.accentColor ?? 'var(--accent)'}"
         aria-selected="${selection.size ? String(selected) : 'false'}">
        <span class="message-row__avatar" aria-hidden="true">${selected ? icon('check') : initialOf(outgoing ? m.to[0] : m.from)}</span>
        <span class="message-row__from">${who}${count ? html` <span class="message-row__count">${count}</span>` : ''}</span>
        <span class="message-row__date">${formatListDate(m.dateReceived ?? m.dateSent)}</span>
        <span class="message-row__subject">${m.subject || '(no subject)'}</span>
        <span class="message-row__icons">
          ${m.hasAttachments ? icon('attach', 'Has attachments') : ''}
          ${m.isFlagged ? icon('star', 'Flagged') : ''}
        </span>
      </a>
    `);
  }

  const list = new VirtualList({
    scroller: body,
    renderRow,
    fetchPage,
  });

  function messageFor(row) {
    return list.loadedItems().find((m) => String(m.id) === row.dataset.id);
  }

  attachRowGestures(list.element, {
    swipeActions(row) {
      const message = messageFor(row);
      if (!message || selection.size) return {};
      const role = folderOf(message)?.role;
      const hasArchive = store.get().folders.some((f) => f.accountId === message.accountId && f.role === 'archive');
      return {
        right: hasArchive && role !== 'archive' ? 'archive' : undefined,
        left: role !== 'trash' ? 'trash' : undefined,
      };
    },
    onSwipe: async (row, action) => runAction(action, await messageIds([row.dataset.id])),
    onLongPress: (row) => toggleSelection(row.dataset.id),
    onActive: (active) => {
      list.paused = active;
      if (!active) list.schedule();
    },
  });

  // In selection mode a tap toggles instead of opening.
  list.element.addEventListener('click', (event) => {
    const row = event.target.closest('.vlist__row[data-id]');
    if (!row || selection.size === 0) return;
    event.preventDefault();
    toggleSelection(row.dataset.id);
  });

  attachPullToRefresh(body, body.querySelector('.pull-indicator'), () => refreshFromServer());

  // --- Selection ---------------------------------------------------------------------------------

  function setSelection(next) {
    selection = next;
    if (selection.size && !unregisterSelection) {
      unregisterSelection = router.pushOverlay(() => setSelection(new Set()));
    } else if (!selection.size && unregisterSelection) {
      unregisterSelection();
      unregisterSelection = null;
    }
    list.draw();
    renderBar();
  }

  function toggleSelection(id) {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  }

  // --- Actions -------------------------------------------------------------------------------------

  function describeMove(action, count, folderName) {
    const what = count === 1 ? 'Message' : `${count} messages`;
    if (action === 'archive') return `${what} archived`;
    if (action === 'trash') return `${what} moved to Trash`;
    return `${what} moved to ${folderName}`;
  }

  async function runAction(action, ids, { folder } = {}) {
    try {
      let token = null;
      if (action === 'archive') token = await actions.archive(ids);
      else if (action === 'trash') token = await actions.trash(ids);
      else if (action === 'move') token = await actions.move(ids, folder.id);
      if (token) {
        snackbar.show(describeMove(action, token.count, folder?.name), {
          action: token.undoable ? 'Undo' : undefined,
          onAction: () => actions.undo(token).catch(onError),
        });
      }
    } catch (error) {
      onError(error);
    }
  }

  async function runSelectionAction(action) {
    const keys = [...selection];
    const rows = list.loadedItems().filter((m) => selection.has(m.id));
    const newest = rows.map((r) => r.messageId);
    try {
      const ids = await messageIds(keys);
      if (action === 'read') {
        // Reading marks the whole conversation; unread marks just its newest message.
        const markRead = rows.some((r) => !r.isRead);
        const threadKeys = keys.filter((k) => !k.startsWith('m:'));
        const targets = markRead ? [...ids, ...(await unreadIdsInThreads(db, threadKeys))] : newest;
        await actions.markRead([...new Set(targets)], markRead);
      } else if (action === 'flag') {
        const flag = rows.some((r) => !r.isFlagged);
        await actions.setFlagged(flag ? newest : ids, flag);
      } else if (action === 'move') {
        const folder = await pickFolder(rows);
        if (!folder) return;
        setSelection(new Set());
        await runAction('move', ids, { folder });
        return;
      } else if (action === 'delete-forever') {
        if (await confirmDeleteForever(ids.length)) await actions.deleteForever(ids);
        else return;
      } else {
        setSelection(new Set());
        await runAction(action, ids);
        return;
      }
    } catch (error) {
      onError(error);
    }
    setSelection(new Set());
  }

  // Set by main.js: folder picker and confirmation dialogs.
  let pickFolder = async () => null;
  let confirmDeleteForever = async () => false;

  function refreshFromServer() {
    if (route.folderId === UNIFIED_INBOX) syncManager.syncAll();
    else syncManager.syncFolderIfStale(Number(route.folderId), { force: true });
  }

  // --- Rendering -----------------------------------------------------------------------------------

  function title() {
    if (route.folderId === UNIFIED_INBOX) return 'Unified Inbox';
    const folder = store.get().folders.find((f) => String(f.id) === route.folderId);
    if (!folder) return 'Folder';
    return folder.role === 'inbox' ? 'Inbox' : folder.name;
  }

  function currentRole() {
    return store.get().folders.find((f) => String(f.id) === route.folderId)?.role ?? null;
  }

  function renderBar() {
    const { accounts, sync, online } = store.get();
    if (selection.size) {
      const selected = list.loadedItems().filter((m) => selection.has(m.id));
      const anyUnread = selected.some((m) => !m.isRead);
      const inTrash = currentRole() === 'trash' || currentRole() === 'junk';
      bar.classList.add('app-bar--selection');
      render(
        bar,
        html`
          <button class="icon-button" type="button" data-selection="clear">${icon('close', 'Clear selection')}</button>
          <h1 class="app-bar__title">${selection.size}</h1>
          <button class="icon-button" type="button" data-selection="read">
            ${icon(anyUnread ? 'drafts-open' : 'mail', anyUnread ? 'Mark read' : 'Mark unread')}
          </button>
          <button class="icon-button" type="button" data-selection="flag">${icon('star', 'Flag')}</button>
          <button class="icon-button" type="button" data-selection="move">${icon('move', 'Move to folder')}</button>
          ${currentRole() === 'archive' ? '' : html`<button class="icon-button" type="button" data-selection="archive">${icon('archive', 'Archive')}</button>`}
          ${inTrash
            ? html`<button class="icon-button" type="button" data-selection="delete-forever">${icon('delete-forever', 'Delete forever')}</button>`
            : html`<button class="icon-button" type="button" data-selection="trash">${icon('delete', 'Delete')}</button>`}
        `,
      );
      return;
    }
    bar.classList.remove('app-bar--selection');
    const syncing = accounts.some((a) => sync[a.id]?.state === 'syncing');
    render(
      bar,
      html`
        <button class="icon-button app-bar__menu" type="button" data-action="open-drawer">${icon('menu', 'Open navigation')}</button>
        <h1 class="app-bar__title">${title()}</h1>
        <button class="icon-button${syncing ? ' icon-button--spinning' : ''}" type="button" data-part="refresh"
          ${accounts.length === 0 || !online ? 'disabled' : ''}>${icon('refresh', 'Check for new mail')}</button>
      `,
    );
  }

  banners.addEventListener('click', (event) => {
    const button = event.target.closest('[data-outbox]');
    if (button) onOutboxAction(button.dataset.outbox, button.dataset.id);
  });

  bar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-selection], [data-part=refresh]');
    if (!button) return;
    if (button.dataset.part === 'refresh') refreshFromServer();
    else if (button.dataset.selection === 'clear') setSelection(new Set());
    else runSelectionAction(button.dataset.selection);
  });

  function outboxBanner() {
    const { outbox } = store.get();
    if (!outbox.length) return '';
    const failed = outbox.filter((item) => item.lastError);
    const waiting = outbox.length === 1 ? '1 message waiting to send' : `${outbox.length} messages waiting to send`;
    return html`<div class="banner${failed.length ? ' banner--error' : ''}" role="status">
      ${icon(failed.length ? 'error' : 'schedule')}
      <p>${waiting}${failed.length ? html`: ${failed[0].lastError.message}` : ''}</p>
      ${failed.length
        ? html`<button class="banner__action text-button" type="button" data-outbox="retry" data-id="${failed[0].id}">Retry</button>
            <button class="banner__action text-button" type="button" data-outbox="edit" data-id="${failed[0].id}">Edit</button>`
        : ''}
    </div>`;
  }

  function renderBanners() {
    const { accounts, sync, online } = store.get();
    render(
      banners,
      html`
        ${outboxBanner()}
        ${online ? '' : html`<div class="banner" role="status">${icon('error')}<p>You’re offline. Showing saved mail.</p></div>`}
        ${accounts
          .filter((a) => sync[a.id]?.state === 'error')
          .map(
            (a) => html`<div class="banner banner--error" role="status">
              ${icon('error')}<p><strong>${a.email}</strong>: ${sync[a.id].error?.message ?? 'Sync failed.'}</p>
              <a class="banner__action" href="#/settings">Fix</a>
            </div>`,
          )}
      `,
    );
  }

  function renderEmpty(count) {
    const { accounts, sync } = store.get();
    const syncing = accounts.some((a) => sync[a.id]?.state === 'syncing');
    if (accounts.length === 0) {
      render(empty, html`<dm-empty-state icon="mail" heading="No accounts yet"
        message="Add an IMAP account to start receiving mail." action-label="Add account"
        action-href="#/accounts/new"></dm-empty-state>`);
    } else if (count === 0) {
      render(empty, html`<dm-empty-state icon="inbox" heading="${syncing ? 'Checking for mail…' : 'Nothing here'}"
        message="${syncing ? '' : 'This folder is empty.'}"></dm-empty-state>`);
    } else {
      empty.replaceChildren();
    }
  }

  async function reload({ reset }) {
    const current = route;
    const count = threading() ? await countThreads(db, query()) : await countMessages(db, query());
    if (current !== route) return;
    if (reset) list.reset(count);
    else list.refresh(count);
    renderEmpty(count);
    // Drop selected messages that are gone (moved or deleted elsewhere).
    if (selection.size) {
      const present = new Set(list.loadedItems().map((m) => m.id));
      const kept = new Set([...selection].filter((id) => present.has(id)));
      if (kept.size !== selection.size) setSelection(kept);
    }
  }

  return {
    /** Shows a mailbox route; reloads the list only when the folder changes. */
    show(next) {
      const folderChanged = next.folderId !== route?.folderId;
      route = next;
      if (folderChanged) {
        setSelection(new Set());
        renderBar();
        reload({ reset: true });
      } else {
        list.draw(); // current-row highlight
      }
    },
    /** Cached mail changed (sync, actions): reload visible rows. */
    dataChanged() {
      if (route) reload({ reset: false });
    },
    statusChanged() {
      if (!route) return;
      renderBar();
      renderBanners();
      renderEmpty(list.count);
    },
    /** Threading switched on or off: rebuild the list. */
    modeChanged() {
      if (!route) return;
      setSelection(new Set());
      reload({ reset: true });
    },
    setDialogs(dialogs) {
      pickFolder = dialogs.pickFolder;
      confirmDeleteForever = dialogs.confirmDeleteForever;
    },
  };
}
