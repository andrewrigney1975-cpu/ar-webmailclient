/**
 * Hash router, aware of panes (PLAN.md §4.9).
 *
 * Routes:
 *   #/folder/:folderId                  message list
 *   #/folder/:folderId/thread/:threadId list + selected thread
 *   #/settings                          settings page
 *   #/accounts/new                      add-account wizard
 *   #/account/:id                       one account's settings
 *   #/compose                           new message
 *   #/compose/:mode/:id                 reply | replyall | forward (message id), or draft (draft id)
 *
 * The selected folder and thread live in the URL at every width, so rotating or
 * unfolding the device keeps the selection. Back navigation is deterministic
 * (not browser history), so deep links from notifications behave sensibly.
 */

export const UNIFIED_INBOX = 'unified';
/** The mailbox "folder" that shows search results. */
export const SEARCH = 'search';
const COMPOSE_MODES = ['reply', 'replyall', 'forward', 'draft', 'mailto'];

export function parseHash(hash) {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);

  if (parts.length === 0) return { name: 'mailbox', folderId: UNIFIED_INBOX, threadId: null };

  if (parts[0] === 'folder' && parts.length === 2) {
    return { name: 'mailbox', folderId: parts[1], threadId: null };
  }
  if (parts[0] === 'folder' && parts.length === 4 && parts[2] === 'thread') {
    return { name: 'mailbox', folderId: parts[1], threadId: parts[3] };
  }
  if (parts[0] === 'settings' && parts.length === 1) return { name: 'settings' };
  if (parts[0] === 'accounts' && parts[1] === 'new' && parts.length === 2) return { name: 'accountSetup' };
  if (parts[0] === 'account' && parts.length === 2) return { name: 'account', accountId: parts[1] };
  if (parts[0] === 'compose' && parts.length === 1) return { name: 'compose', mode: 'new', id: null };
  if (parts[0] === 'compose' && parts.length === 3 && COMPOSE_MODES.includes(parts[1])) {
    return { name: 'compose', mode: parts[1], id: parts[2] };
  }

  return { name: 'notFound' };
}

export function buildHash(route) {
  switch (route.name) {
    case 'mailbox': {
      const folder = `#/folder/${encodeURIComponent(route.folderId)}`;
      return route.threadId ? `${folder}/thread/${encodeURIComponent(route.threadId)}` : folder;
    }
    case 'settings':
      return '#/settings';
    case 'accountSetup':
      return '#/accounts/new';
    case 'account':
      return `#/account/${encodeURIComponent(route.accountId)}`;
    case 'compose':
      return route.mode && route.mode !== 'new'
        ? `#/compose/${route.mode}/${encodeURIComponent(route.id)}`
        : '#/compose';
    default:
      return `#/folder/${UNIFIED_INBOX}`;
  }
}

/**
 * The route that "back" leads to, or null when back should leave the app.
 * `lastMailbox` is where full-screen pages return to.
 */
export function parentOf(route, lastMailbox) {
  switch (route.name) {
    case 'mailbox':
      if (route.threadId) return { ...route, threadId: null };
      if (route.folderId !== UNIFIED_INBOX) {
        return { name: 'mailbox', folderId: UNIFIED_INBOX, threadId: null };
      }
      return null;
    case 'account':
      return { name: 'settings' };
    case 'settings':
    case 'accountSetup':
    case 'compose':
    case 'notFound':
      return lastMailbox ?? { name: 'mailbox', folderId: UNIFIED_INBOX, threadId: null };
    default:
      return null;
  }
}

export function createRouter({ onChange, win = window }) {
  let current = parseHash(win.location.hash);
  let lastMailbox = null;
  // Closable UI layers (drawer, sheets, dialogs), closed by back before navigating.
  const overlays = [];

  function resolve() {
    current = parseHash(win.location.hash);
    if (current.name === 'mailbox') lastMailbox = current;
    onChange(current);
  }

  function navigate(route, { replace = false } = {}) {
    const hash = buildHash(route);
    if (hash === win.location.hash) return;
    if (replace) {
      win.location.replace(hash);
    } else {
      win.location.hash = hash;
    }
  }

  return {
    start() {
      win.addEventListener('hashchange', resolve);
      resolve();
    },

    get current() {
      return current;
    },

    navigate,

    /** Register a closable layer. Returns a function to unregister it. */
    pushOverlay(close) {
      overlays.push(close);
      return () => {
        const index = overlays.lastIndexOf(close);
        if (index !== -1) overlays.splice(index, 1);
      };
    },

    /** Handles a back gesture. Returns false when the app should exit. */
    back() {
      if (overlays.length > 0) {
        overlays.pop()();
        return true;
      }
      const parent = parentOf(current, lastMailbox);
      if (!parent) return false;
      navigate(parent, { replace: true });
      return true;
    },
  };
}
