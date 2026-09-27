import './views/components/dm-empty-state.js';
import { createStore } from './store.js';
import { createRouter, UNIFIED_INBOX } from './router.js';
import { isDrawerModal, watchWidthClass } from './layout.js';
import { applyAccent, watchColorScheme } from './theme/theme.js';
import { initPlatform, openExternal } from './platform.js';
import { openDatabase } from './db/database.js';
import { deleteAccount, listAccounts } from './db/repo-accounts.js';
import { adjustUnreadCount, listFolders } from './db/repo-folders.js';
import { getMessage, listMessages, saveBody, setLocalFlags } from './db/repo-messages.js';
import { mail } from './mail/bridge.js';
import { discover } from './mail/autoconfig.js';
import { getText } from './net/http.js';
import { createSyncManager } from './mail/sync-manager.js';
import { addAccount } from './accounts/setup.js';
import { htmlToText, snippetOf } from './util/format.js';
import { renderDrawer } from './views/drawer.js';
import { renderMailbox } from './views/mailbox.js';
import { renderThread } from './views/thread.js';
import { renderSettings } from './views/settings.js';
import { createAccountSetupView } from './views/account-setup.js';

const app = document.getElementById('app');
const drawer = document.getElementById('drawer');
const scrim = document.getElementById('scrim');
const listPane = document.getElementById('list-pane');
const readingPane = document.getElementById('reading-pane');
const page = document.getElementById('page');
const setupPage = document.getElementById('setup-page');

const store = createStore({
  route: null,
  lastMailboxRoute: null,
  widthClass: 'compact',
  colorScheme: 'light',
  online: true,
  drawerOpen: false,
  accounts: [],
  folders: [],
  sync: {},
  dataVersion: 0,
  messages: [],
  selected: null, // { message, body, bodyError }
  confirmRemoveId: null,
});

const db = await openDatabase();
const syncManager = createSyncManager({ db, mail, store });

// Development builds only: handles for debugging from the console.
if (import.meta.env.DEV) window.despatch = { db, store, mail, syncManager };

const router = createRouter({
  onChange: (route) => {
    const changes = { route, drawerOpen: false, confirmRemoveId: null };
    if (route.name === 'mailbox') changes.lastMailboxRoute = route;
    store.set(changes);
  },
});

// --- Data loading ------------------------------------------------------------------------------

async function loadAccounts() {
  store.set({ accounts: await listAccounts(db), folders: await listFolders(db) });
}

function mailboxQuery(route) {
  return route.folderId === UNIFIED_INBOX ? { unified: true } : { folderId: Number(route.folderId) };
}

async function loadMessages() {
  const route = store.get().lastMailboxRoute;
  if (!route) return;
  const messages = await listMessages(db, mailboxQuery(route));
  if (store.get().lastMailboxRoute === route) store.set({ messages });
}

/** Loads the selected message, fetching and caching its body, and marks it read. */
async function loadSelected() {
  const route = store.get().lastMailboxRoute;
  const id = Number(route?.threadId);
  if (!id) {
    store.set({ selected: null });
    return;
  }
  const message = await getMessage(db, id);
  if (!message) {
    store.set({ selected: null });
    return;
  }
  const isCurrent = () => Number(store.get().lastMailboxRoute?.threadId) === id;
  const cached = message.bodyFetchedAt ? message.bodyText ?? htmlToText(message.bodyHtml ?? '') : undefined;
  store.set({ selected: { message, body: cached, bodyError: null } });

  const { accounts, folders } = store.get();
  const account = accounts.find((a) => a.id === message.accountId);
  const folder = folders.find((f) => f.id === message.folderId);
  if (!account || !folder) return;

  if (!message.isRead) {
    const flags = [...message.flags, '\\Seen'];
    await setLocalFlags(db, id, flags);
    await adjustUnreadCount(db, folder.id, -1);
    store.set({ folders: await listFolders(db), dataVersion: store.get().dataVersion + 1 });
    mail.setFlags(account, folder.path, [message.uid], { add: ['\\Seen'] }).catch(() => {
      // The next sync reconciles flags with the server.
    });
  }

  if (cached !== undefined) return;
  try {
    const body = await mail.fetchBody(account, folder.path, message.uid);
    const text = body.text ?? (body.html ? htmlToText(body.html) : '');
    await saveBody(db, id, { text: body.text, html: body.html, snippet: snippetOf(text) });
    if (isCurrent()) store.set({ selected: { message, body: text, bodyError: null } });
  } catch (error) {
    if (isCurrent()) store.set({ selected: { message, body: undefined, bodyError: error.message } });
  }
}

// --- Rendering ---------------------------------------------------------------------------------

let unregisterDrawer = null;
function setDrawerOpen(open) {
  store.set({ drawerOpen: open });
}

const accountSetup = createAccountSetupView({
  element: setupPage,
  onSubmit: (form) =>
    addAccount(form, {
      db,
      mail,
      discover: (email) => discover(email, { http: (url, options) => getText(url, options) }),
      existingAccounts: store.get().accounts,
    }),
  onOpenUrl: openExternal,
  async onDone(account) {
    await loadAccounts();
    router.navigate({ name: 'mailbox', folderId: UNIFIED_INBOX, threadId: null }, { replace: true });
    syncManager.syncAccount(account);
  },
});

function renderApp(state, previous = {}) {
  const { route, drawerOpen, widthClass } = state;
  if (!route) return;

  const mailboxRoute = route.name === 'mailbox' ? route : state.lastMailboxRoute;

  page.hidden = route.name !== 'settings';
  setupPage.hidden = route.name !== 'accountSetup';
  if (route.name === 'settings') renderSettings(page, state);
  if (route.name === 'accountSetup' && previous.route?.name !== 'accountSetup') accountSetup.reset();

  const modalDrawer = isDrawerModal(widthClass);
  app.toggleAttribute('data-drawer-open', drawerOpen && modalDrawer);
  drawer.inert = modalDrawer && !drawerOpen;
  if (drawerOpen && modalDrawer && !unregisterDrawer) {
    unregisterDrawer = router.pushOverlay(() => setDrawerOpen(false));
  } else if (!(drawerOpen && modalDrawer) && unregisterDrawer) {
    unregisterDrawer();
    unregisterDrawer = null;
  }

  if (route !== previous.route || state.accounts !== previous.accounts || state.folders !== previous.folders) {
    renderDrawer(drawer, state);
  }

  // Account accent: the folder's account, or the first account in the unified inbox.
  const folder = mailboxRoute && state.folders.find((f) => String(f.id) === mailboxRoute.folderId);
  const accent = state.accounts.find((a) => a.id === folder?.accountId)?.accentColor ?? state.accounts[0]?.accentColor;
  applyAccent(document.documentElement, accent);

  if (!mailboxRoute) return;
  app.toggleAttribute('data-has-thread', Boolean(mailboxRoute.threadId));

  const listChanged = ['lastMailboxRoute', 'messages', 'accounts', 'sync', 'online', 'folders'].some(
    (key) => state[key] !== previous[key],
  );
  if (listChanged) {
    renderMailbox(listPane, { ...state, route: mailboxRoute, folder });
  }
  if (state.selected !== previous.selected || mailboxRoute !== previous.lastMailboxRoute) {
    const selected = state.selected?.message.id === Number(mailboxRoute.threadId) ? state.selected : null;
    renderThread(readingPane, {
      route: mailboxRoute,
      message: selected?.message,
      account: state.accounts.find((a) => a.id === selected?.message.accountId),
      body: selected?.body,
      bodyError: selected?.bodyError,
    });
  }
}

store.subscribe(renderApp);

// Reload data when what it depends on changes.
store.subscribe((state, previous) => {
  const route = state.lastMailboxRoute;
  const folderChanged = route?.folderId !== previous.lastMailboxRoute?.folderId;
  if (folderChanged || state.dataVersion !== previous.dataVersion || state.accounts !== previous.accounts) {
    loadMessages();
  }
  if (folderChanged && route && route.folderId !== UNIFIED_INBOX) {
    syncManager.syncFolderIfStale(Number(route.folderId));
  }
  if (route?.threadId !== previous.lastMailboxRoute?.threadId) loadSelected();
});

// --- Actions -----------------------------------------------------------------------------------

async function removeAccount(accountId) {
  if (store.get().confirmRemoveId !== accountId) {
    store.set({ confirmRemoveId: accountId });
    return;
  }
  await mail.deleteCredentials(accountId).catch(() => {});
  await mail.disconnect(accountId).catch(() => {});
  await deleteAccount(db, accountId);
  store.set((state) => {
    const { [accountId]: _removed, ...sync } = state.sync;
    return { sync, confirmRemoveId: null };
  });
  await loadAccounts();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  switch (target?.dataset.action) {
    case 'open-drawer':
      setDrawerOpen(true);
      break;
    case 'back':
      router.back();
      break;
    case 'refresh': {
      const route = store.get().lastMailboxRoute;
      if (route && route.folderId !== UNIFIED_INBOX) {
        syncManager.syncFolderIfStale(Number(route.folderId), { force: true });
      } else {
        syncManager.syncAll();
      }
      break;
    }
    case 'remove-account':
      removeAccount(target.dataset.accountId);
      break;
  }
  // Also covers tapping the current destination, where no hashchange fires.
  if (event.target.closest('.nav__item')) setDrawerOpen(false);
});
scrim.addEventListener('click', () => setDrawerOpen(false));

// --- Start -------------------------------------------------------------------------------------

applyAccent(document.documentElement);
watchColorScheme({ store });
watchWidthClass({ root: app, store });
await loadAccounts();
router.start();
await initPlatform({
  router,
  store,
  onResume: () => syncManager.syncAll(),
  onOnline: () => syncManager.syncAll(),
});
syncManager.start();
