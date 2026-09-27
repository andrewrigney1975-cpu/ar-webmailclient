import './views/components/dm-empty-state.js';
import { createStore } from './store.js';
import { loadListPrefs, loadSettings, saveSettings } from './settings.js';
import { createRouter, UNIFIED_INBOX } from './router.js';
import { isDrawerModal, watchWidthClass } from './layout.js';
import { applyAccent, watchColorScheme } from './theme/theme.js';
import { initPlatform, openExternal } from './platform.js';
import { openDatabase } from './db/database.js';
import { deleteAccount, listAccounts } from './db/repo-accounts.js';
import { listFolders } from './db/repo-folders.js';
import { mail } from './mail/bridge.js';
import { discover } from './mail/autoconfig.js';
import { getText } from './net/http.js';
import { createSyncManager } from './mail/sync-manager.js';
import { createMessageActions } from './mail/actions.js';
import { createOutbox } from './mail/outbox.js';
import { addAccount } from './accounts/setup.js';
import { renderDrawer } from './views/drawer.js';
import { createMailboxView } from './views/mailbox.js';
import { createThreadView } from './views/thread-view.js';
import { renderSettings } from './views/settings.js';
import { createAccountSetupView } from './views/account-setup.js';
import { createComposeView } from './views/compose.js';
import { createAccountSettingsView } from './views/account-settings.js';
import { createNotifications } from './notify/notifications.js';
import { chooseFromSheet, confirmDialog, createSnackbar } from './views/components/overlays.js';

const app = document.getElementById('app');
const drawer = document.getElementById('drawer');
const scrim = document.getElementById('scrim');
const listPane = document.getElementById('list-pane');
const readingPane = document.getElementById('reading-pane');
const page = document.getElementById('page');
const setupPage = document.getElementById('setup-page');
const composePage = document.getElementById('compose-page');
const accountPage = document.getElementById('account-page');

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
  confirmRemoveId: null,
  settings: await loadSettings(),
  listPrefs: await loadListPrefs(),
  outbox: [],
});

const db = await openDatabase();
const syncManager = createSyncManager({ db, mail, store });
const actions = createMessageActions({ db, mail, store });
const snackbar = createSnackbar(document.getElementById('snackbar'));
const outbox = createOutbox({ db, mail, store });

const router = createRouter({
  onChange: (route) => {
    const changes = { route, drawerOpen: false, confirmRemoveId: null };
    if (route.name === 'mailbox') changes.lastMailboxRoute = route;
    store.set(changes);
  },
});

const notifications = createNotifications({ db, mail, store, router, syncManager, onError: (e) => console.warn(e) });

// Development builds only: handles for debugging from the console.
if (import.meta.env.DEV) window.despatch = { db, store, mail, syncManager, actions, router, outbox };

function showError(error) {
  snackbar.show(error?.message ?? 'Something went wrong.');
}

// --- Dialogs shared by the list and the reading pane -------------------------------------------

const ROLE_ICONS = { inbox: 'inbox', sent: 'send', drafts: 'draft', trash: 'delete', archive: 'archive', junk: 'report' };

async function pickFolder(messages) {
  const accountIds = new Set(messages.map((m) => m.accountId));
  if (accountIds.size !== 1) {
    snackbar.show('Select messages from one account to move them to a folder.');
    return null;
  }
  const [accountId] = accountIds;
  const current = new Set(messages.map((m) => m.folderId));
  const items = store
    .get()
    .folders.filter((f) => f.accountId === accountId && f.selectable && !current.has(f.id))
    .map((f) => ({
      value: f,
      label: f.role === 'inbox' ? 'Inbox' : f.name,
      icon: ROLE_ICONS[f.role] ?? 'folder',
      depth: f.role || !f.delimiter ? 0 : f.path.split(f.delimiter).length - 1,
    }));
  return chooseFromSheet(router, { title: 'Move to', items });
}

function confirmDeleteForever(count) {
  return confirmDialog(router, {
    title: count === 1 ? 'Delete this message forever?' : `Delete ${count} messages forever?`,
    message: 'They will be removed from the server and can’t be recovered.',
    confirm: 'Delete forever',
    danger: true,
  });
}

// --- Views ---------------------------------------------------------------------------------------

const mailboxView = createMailboxView({
  element: listPane,
  db,
  mail,
  chooseFromSheet,
  store,
  router,
  actions,
  syncManager,
  snackbar,
  onError: showError,
  async onOutboxAction(action, id) {
    if (action === 'retry') await outbox.retry(id).catch(showError);
    if (action === 'edit') {
      const item = await outbox.cancel(id);
      if (item?.data.draftId) router.navigate({ name: 'compose', mode: 'draft', id: item.data.draftId });
    }
  },
});
mailboxView.setDialogs({ pickFolder, confirmDeleteForever });

const threadView = createThreadView({
  element: readingPane,
  db,
  store,
  mail,
  actions,
  snackbar,
  onError: showError,
  openExternal,
  onCompose: (route) => router.navigate(route),
  router,
  dialogs: { pickFolder, confirmDeleteForever },
  onClose: () => {
    const route = store.get().lastMailboxRoute;
    if (route?.threadId) router.navigate({ ...route, threadId: null }, { replace: true });
  },
});

async function loadAccounts() {
  store.set({ accounts: await listAccounts(db), folders: await listFolders(db) });
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
    notifications.requestPermissionOnce();
  },
});

const composeView = createComposeView({
  element: composePage,
  db,
  store,
  mail,
  outbox,
  router,
  snackbar,
  onError: showError,
});

const accountSettings = createAccountSettingsView({
  element: accountPage,
  db,
  store,
  mail,
  snackbar,
  onSaved: loadAccounts,
  onPasswordChanged: (account) => syncManager.syncAccount(account),
});

// --- Rendering -----------------------------------------------------------------------------------

let unregisterDrawer = null;
function setDrawerOpen(open) {
  store.set({ drawerOpen: open });
}

function renderApp(state, previous = {}) {
  const { route, drawerOpen, widthClass } = state;
  if (!route) return;

  const mailboxRoute = route.name === 'mailbox' ? route : state.lastMailboxRoute;

  page.hidden = route.name !== 'settings';
  setupPage.hidden = route.name !== 'accountSetup';
  composePage.hidden = route.name !== 'compose';
  accountPage.hidden = route.name !== 'account';
  if (route.name === 'account' && route !== previous.route) accountSettings.open(route.accountId);
  if (previous.route?.name === 'account' && route !== previous.route) accountSettings.close();
  if (route.name === 'compose' && route !== previous.route) composeView.open(route);
  if (previous.route?.name === 'compose' && route !== previous.route) composeView.close();
  if (route.name === 'settings') renderSettings(page, { ...state, notificationStatus });
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

  if (mailboxRoute !== previous.lastMailboxRoute) {
    mailboxView.show(mailboxRoute);
    threadView.show(mailboxRoute);
  }
  if (state.settings.threading !== previous.settings?.threading && previous.settings) {
    mailboxView.modeChanged();
  }
  if (['accounts', 'sync', 'online', 'folders', 'outbox'].some((key) => state[key] !== previous[key])) {
    mailboxView.statusChanged();
  }
  if (state.dataVersion !== previous.dataVersion || state.accounts !== previous.accounts) {
    mailboxView.dataChanged();
    threadView.dataChanged();
  }
}

store.subscribe(renderApp);

// Opening a folder syncs it if it hasn't synced recently.
store.subscribe((state, previous) => {
  const route = state.lastMailboxRoute;
  if (route && route.folderId !== previous.lastMailboxRoute?.folderId && /^\d+$/.test(route.folderId)) {
    syncManager.syncFolderIfStale(Number(route.folderId));
  }
});

// --- Actions -------------------------------------------------------------------------------------

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
    return { sync, confirmRemoveId: null, dataVersion: state.dataVersion + 1 };
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
    case 'remove-account':
      removeAccount(target.dataset.accountId);
      break;
    case 'toggle-setting':
      updateSetting(target.dataset.setting, target.checked);
      break;
    case 'notification-settings':
      notifications.openSystemSettings().catch(showError);
      break;
    case 'notification-permission':
      notifications.requestPermission().then(refreshNotificationStatus).catch(showError);
      break;
  }
  // Also covers tapping the current destination, where no hashchange fires.
  if (event.target.closest('.nav__item')) setDrawerOpen(false);
});
scrim.addEventListener('click', () => setDrawerOpen(false));
document.addEventListener('change', (event) => {
  const select = event.target.closest('select[data-setting]');
  if (select) updateSetting(select.dataset.setting, Number(select.value));
});

function updateSetting(key, value) {
  const settings = { ...store.get().settings, [key]: value };
  store.set({ settings });
  saveSettings(settings).catch(showError);
}

let notificationStatus = null;
async function refreshNotificationStatus() {
  notificationStatus = await notifications.status().catch(() => null);
  if (store.get().route?.name === 'settings') renderSettings(page, { ...store.get(), notificationStatus });
}

// --- Start ---------------------------------------------------------------------------------------

applyAccent(document.documentElement);
watchColorScheme({ store });
watchWidthClass({ root: app, store });
await loadAccounts();
router.start();
await initPlatform({
  router,
  store,
  onResume: () => {
    syncManager.syncAll();
    outbox.process();
    refreshNotificationStatus();
  },
  onOnline: () => {
    syncManager.syncAll();
    outbox.process();
  },
});
syncManager.start();
await outbox.refresh();
outbox.process();
await notifications.start();
refreshNotificationStatus();
