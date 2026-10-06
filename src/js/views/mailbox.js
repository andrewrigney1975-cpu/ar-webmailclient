/**
 * The message list pane: app bar (or selection bar), status banners,
 * pull-to-refresh, and a virtualised list with swipe and long-press.
 *
 * Rows are conversations when threading is on, otherwise single messages.
 * Either way a row's `id` is a conversation key ("m:<id>" for a single
 * message), which is also the route's threadId; actions turn keys into the
 * message IDs in the current folder.
 *
 * The folder "search" shows search results (single messages, PLAN.md §4.6);
 * each opens its whole conversation.
 */
import { html, icon, markup, render } from '../html.js';
import { buildHash, SEARCH, UNIFIED_INBOX } from '../router.js';
import { listPrefsFor, saveListPrefs } from '../settings.js';
import { parseQuery, hasToken, isEmptyQuery, toggleToken } from '../search/query-parser.js';
import { countSearch, MARK_END, MARK_START, searchMessages } from '../search/search.js';
import { searchServer } from '../search/server-search.js';
import { countMessages, listMessages } from '../db/repo-messages.js';
import { countThreads, listThreads, messageIdsInThreads, unreadIdsInThreads } from '../db/repo-threads.js';
import { displayName, formatListDate, formatSize } from '../util/format.js';
import { VirtualList } from './components/virtual-list.js';
import { attachPullToRefresh, attachRowGestures } from './components/gestures.js';

const SWIPE_LABELS = { archive: 'Archive', trash: 'Delete' };

function initialOf(person) {
  const text = displayName(person).replace(/^[^\p{L}\p{N}]+/u, '');
  return (text[0] ?? '?').toUpperCase();
}

const SORT_OPTIONS = [
  { value: { sort: 'dateReceived', descending: true }, label: 'Newest first' },
  { value: { sort: 'dateReceived', descending: false }, label: 'Oldest first' },
  { value: { sort: 'dateSent', descending: true }, label: 'Date sent' },
  { value: { sort: 'sender', descending: false }, label: 'Sender (A–Z)' },
  { value: { sort: 'sender', descending: true }, label: 'Sender (Z–A)' },
  { value: { sort: 'size', descending: true }, label: 'Largest first' },
  { value: { sort: 'size', descending: false }, label: 'Smallest first' },
];
const ATTACHMENT_OPTIONS = [
  { value: 'any', label: 'All messages' },
  { value: 'with', label: 'With attachments' },
  { value: 'without', label: 'Without attachments' },
];
const SEARCH_CHIPS = [
  { token: 'is:unread', label: 'Unread' },
  { token: 'is:flagged', label: 'Flagged' },
  { token: 'has:attachment', label: 'Attachments' },
];

/** A snippet is worth showing unless the match was just the subject line. */
function showSnippet(message) {
  if (!message.searchSnippet) return false;
  const plain = message.searchSnippet.replace(new RegExp(`[${MARK_START}${MARK_END}]`, 'g'), '').trim();
  return plain.toLowerCase() !== (message.subject ?? '').trim().toLowerCase();
}

/** Escapes a search snippet and turns the match markers into <mark>. */
function highlighted(snippet) {
  const parts = snippet.split(new RegExp(`(${MARK_START}[^${MARK_END}]*${MARK_END})`));
  return parts.map((part) =>
    part.startsWith(MARK_START) ? html`<mark>${part.slice(1, -1)}</mark>` : part.replaceAll(MARK_START, '').replaceAll(MARK_END, ''),
  );
}

export function createMailboxView({
  element,
  db,
  mail,
  store,
  router,
  actions,
  syncManager,
  snackbar,
  onError,
  onOutboxAction,
  chooseFromSheet,
}) {
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
  let searchText = '';
  let searchTimer = null;
  let searchingServer = false;
  let barMode = null;

  const folderOf = (message) => store.get().folders.find((f) => f.id === message.folderId);
  const accountOf = (message) => store.get().accounts.find((a) => a.id === message.accountId);
  const query = () => (route.folderId === UNIFIED_INBOX ? { unified: true } : { folderId: Number(route.folderId) });
  const searching = () => route?.folderId === SEARCH;
  const threading = () => store.get().settings.threading && !searching();
  const prefs = () => listPrefsFor(store.get().listPrefs, route.folderId);
  const listOptions = () => {
    const { sort, descending, attachments } = prefs();
    return { sort, descending, attachments };
  };
  const isMe = (person) => store.get().accounts.some((a) => a.email === person?.address?.toLowerCase());

  function asRow(message) {
    return {
      ...message,
      id: `m:${message.id}`,
      openKey: searching() ? (message.threadId ?? `m:${message.id}`) : `m:${message.id}`,
      messageId: message.id,
      thread: null,
    };
  }

  async function fetchPage(offset, limit) {
    if (searching()) {
      const { sort, descending } = listOptions();
      return (await searchMessages(db, parseQuery(searchText), { sort, descending, offset, limit })).map(asRow);
    }
    if (threading()) return listThreads(db, { ...query(), ...listOptions(), offset, limit });
    return (await listMessages(db, { ...query(), ...listOptions(), offset, limit })).map(asRow);
  }

  /** Message IDs in the current folder for these row keys. */
  async function messageIds(keys) {
    const single = keys.filter((k) => k.startsWith('m:')).map((k) => Number(k.slice(2)));
    if (searching()) return single;
    const threads = keys.filter((k) => !k.startsWith('m:'));
    return [...single, ...(await messageIdsInThreads(db, threads, query()))];
  }

  function participants(row) {
    const people = row.thread?.participants ?? [];
    if (people.length === 0) return displayName(row.from);
    // Full names while they fit ("The Cheesecake Shop", not "The"); first names only for busier threads.
    const short = people.length > 2;
    const names = people.map((p) => (isMe(p) ? 'me' : short ? displayName(p).split(/[\s@]/)[0] : displayName(p)));
    return names.length > 3 ? `${names[0]} … ${names.slice(-2).join(', ')}` : names.join(', ');
  }

  function renderRow(m) {
    const folder = folderOf(m);
    const outgoing = folder?.role === 'sent' || folder?.role === 'drafts';
    const who = outgoing ? `To: ${m.to.map(displayName).join(', ') || '(no recipients)'}` : participants(m);
    const count = m.thread?.count > 1 ? m.thread.count : 0;
    const selected = selection.has(m.id);
    const openKey = String(m.openKey ?? m.id);
    const classes = [
      'message-row',
      m.isRead ? '' : 'message-row--unread',
      openKey === route.threadId ? 'message-row--current' : '',
      selected ? 'message-row--selected' : '',
    ].join(' ');
    return markup(html`
      <div class="vlist__action vlist__action--right">${icon('archive')}<span>${SWIPE_LABELS.archive}</span></div>
      <div class="vlist__action vlist__action--left"><span>${SWIPE_LABELS.trash}</span>${icon('delete')}</div>
      <a class="${classes}" href="${buildHash({ ...route, threadId: openKey })}"
         style="--row-accent: ${accountOf(m)?.accentColor ?? 'var(--accent)'}"
         aria-selected="${selection.size ? String(selected) : 'false'}">
        <span class="message-row__avatar" aria-hidden="true">${selected ? icon('check') : initialOf(outgoing ? m.to[0] : m.from)}</span>
        <span class="message-row__from">${who}${count ? html` <span class="message-row__count">${count}</span>` : ''}</span>
        <span class="message-row__date">${formatListDate(m.dateReceived ?? m.dateSent)}</span>
        <span class="message-row__size" aria-hidden="true">${formatSize(m.size ?? 0)}</span>
        <span class="message-row__subject">${m.subject || '(no subject)'}${showSnippet(m) ? html` <span class="message-row__snippet">— ${highlighted(m.searchSnippet)}</span>` : ''}</span>
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
    if (searching()) runServerSearch();
    else if (route.folderId === UNIFIED_INBOX) syncManager.syncAll();
    else syncManager.syncFolderIfStale(Number(route.folderId), { force: true });
  }

  // --- Search and sort -------------------------------------------------------------------------------

  function setSearchText(text, { immediate = false } = {}) {
    searchText = text;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => reload({ reset: true }), immediate ? 0 : 250);
    renderSearchChips();
  }

  async function runServerSearch() {
    const query = parseQuery(searchText);
    if (isEmptyQuery(query) || searchingServer) return;
    searchingServer = true;
    renderSearchChips();
    try {
      const found = await searchServer({ db, mail, store, query });
      snackbar.show(found ? `Found ${found} more on the server.` : 'Nothing more on the server.');
      await reload({ reset: false });
    } catch (error) {
      onError(error);
    } finally {
      searchingServer = false;
      renderSearchChips();
    }
  }

  async function chooseSort() {
    const current = prefs();
    const choice = await chooseFromSheet(router, {
      title: 'Sort and filter',
      items: [
        { heading: 'Sort by' },
        ...SORT_OPTIONS.map((o) => ({
          value: { ...current, ...o.value },
          label: o.label,
          icon: o.value.sort === current.sort && o.value.descending === current.descending ? 'check' : 'blank',
        })),
        ...(searching()
          ? []
          : [
              { heading: 'Show' },
              ...ATTACHMENT_OPTIONS.map((o) => ({
                value: { ...current, attachments: o.value },
                label: o.label,
                icon: o.value === current.attachments ? 'check' : 'blank',
              })),
            ]),
      ],
    });
    if (!choice) return;
    const listPrefs = { ...store.get().listPrefs, [route.folderId]: choice };
    store.set({ listPrefs });
    saveListPrefs(listPrefs).catch(() => {});
    reload({ reset: true });
    renderBar();
  }

  function renderSearchChips() {
    const chips = element.querySelector('[data-part=search-chips]');
    if (!chips) return;
    render(
      chips,
      html`${SEARCH_CHIPS.map(
        (chip) => html`<button class="filter-chip" type="button" data-search-token="${chip.token}"
          aria-pressed="${String(hasToken(searchText, chip.token))}">${chip.label}</button>`,
      )}
      <button class="filter-chip" type="button" data-search="server" ${searchingServer || isEmptyQuery(parseQuery(searchText)) ? 'disabled' : ''}>
        ${searchingServer ? 'Searching server…' : 'Search server'}
      </button>`,
    );
  }

  // --- Rendering -----------------------------------------------------------------------------------

  function title() {
    if (route.folderId === UNIFIED_INBOX) return 'Unified Inbox';
    if (searching()) return 'Search';
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

    if (searching()) {
      // Render the search field once, so typing isn't interrupted by status updates.
      if (barMode === 'search') return;
      barMode = 'search';
      render(
        bar,
        html`
          <div class="search-bar">
            <button class="icon-button" type="button" data-action="back">${icon('back', 'Close search')}</button>
            <input class="search-bar__input" type="search" enterkeyhint="search" placeholder="Search mail"
              aria-label="Search mail" value="${searchText}" autocapitalize="off" spellcheck="false" />
            <button class="icon-button" type="button" data-search="sort">${icon('sort', 'Sort')}</button>
          </div>
          <div class="search-chips" data-part="search-chips"></div>
        `,
      );
      renderSearchChips();
      const input = bar.querySelector('.search-bar__input');
      input.addEventListener('input', () => setSearchText(input.value));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          setSearchText(input.value, { immediate: true });
          input.blur();
        }
      });
      requestAnimationFrame(() => input.focus());
      return;
    }

    barMode = 'normal';
    const syncing = accounts.some((a) => sync[a.id]?.state === 'syncing');
    const filtered = prefs().attachments !== 'any' || prefs().sort !== 'dateReceived' || !prefs().descending;
    render(
      bar,
      html`
        <button class="icon-button app-bar__menu" type="button" data-action="open-drawer">${icon('menu', 'Open navigation')}</button>
        <h1 class="app-bar__title">${title()}</h1>
        <button class="icon-button" type="button" data-search="open">${icon('search', 'Search')}</button>
        <button class="icon-button${filtered ? ' icon-button--active' : ''}" type="button" data-search="sort"
          aria-pressed="${String(filtered)}">${icon('sort', 'Sort and filter')}</button>
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
    const button = event.target.closest('[data-selection], [data-part=refresh], [data-search], [data-search-token]');
    if (!button) return;
    if (button.dataset.searchToken) {
      const next = toggleToken(searchText, button.dataset.searchToken);
      bar.querySelector('.search-bar__input').value = next;
      setSearchText(next, { immediate: true });
    } else if (button.dataset.search === 'open') {
      router.navigate({ name: 'mailbox', folderId: SEARCH, threadId: null });
    } else if (button.dataset.search === 'sort') chooseSort();
    else if (button.dataset.search === 'server') runServerSearch();
    else if (button.dataset.part === 'refresh') refreshFromServer();
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
    } else if (searching() && count === 0) {
      const blank = isEmptyQuery(parseQuery(searchText));
      render(empty, html`<dm-empty-state icon="search" heading="${blank ? 'Search your mail' : 'No results on this device'}"
        message="${blank ? 'Try from:, to:, subject:, has:attachment, is:unread, before: or larger:5M.' : 'Try “Search server” for older mail.'}"></dm-empty-state>`);
    } else if (count === 0) {
      render(empty, html`<dm-empty-state icon="inbox" heading="${syncing ? 'Checking for mail…' : 'Nothing here'}"
        message="${syncing ? '' : prefs().attachments !== 'any' ? 'No messages match the filter.' : 'This folder is empty.'}"></dm-empty-state>`);
    } else {
      empty.replaceChildren();
    }
  }

  async function reload({ reset }) {
    const current = route;
    const scoped = searching() ? null : { ...query(), ...listOptions() };
    let count;
    if (searching()) count = isEmptyQuery(parseQuery(searchText)) ? 0 : await countSearch(db, parseQuery(searchText));
    else if (threading()) count = await countThreads(db, scoped);
    else count = await countMessages(db, scoped);
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
        barMode = null;
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
    /**
     * Opens the next (+1) or previous (-1) conversation, for keyboard
     * shortcuts. Returns false when there's nothing there.
     */
    openAdjacent(delta) {
      if (!route) return false;
      let index = -1;
      for (let i = 0; i < list.count; i++) {
        const item = list.item(i);
        if (item && String(item.openKey ?? item.id) === route.threadId) {
          index = i;
          break;
        }
      }
      const targetIndex = index === -1 ? 0 : index + delta;
      const target = list.item(targetIndex);
      if (!target) return false;
      router.navigate({ ...route, threadId: String(target.openKey ?? target.id) }, { replace: Boolean(route.threadId) });
      const top = targetIndex * list.rowHeight;
      if (top < body.scrollTop || top + list.rowHeight > body.scrollTop + body.clientHeight) {
        body.scrollTop = top - body.clientHeight / 2;
      }
      return true;
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
