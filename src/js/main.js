import './views/components/dm-empty-state.js';
import { createStore } from './store.js';
import { createRouter } from './router.js';
import { isDrawerModal, watchWidthClass } from './layout.js';
import { applyAccent, watchColorScheme } from './theme/theme.js';
import { initPlatform } from './platform.js';
import { renderDrawer } from './views/drawer.js';
import { renderMailbox } from './views/mailbox.js';
import { renderThread } from './views/thread.js';
import { renderSettings } from './views/settings.js';

const app = document.getElementById('app');
const drawer = document.getElementById('drawer');
const scrim = document.getElementById('scrim');
const listPane = document.getElementById('list-pane');
const readingPane = document.getElementById('reading-pane');
const page = document.getElementById('page');

const store = createStore({
  route: null,
  lastMailboxRoute: null,
  widthClass: 'compact',
  colorScheme: 'light',
  online: true,
  drawerOpen: false,
});

const router = createRouter({
  onChange: (route) => {
    const changes = { route, drawerOpen: false };
    if (route.name === 'mailbox') changes.lastMailboxRoute = route;
    store.set(changes);
  },
});

// Drawer: registered as an overlay so back closes it first.
let unregisterDrawer = null;
function setDrawerOpen(open) {
  store.set({ drawerOpen: open });
}

function renderApp(state, previous = {}) {
  const { route, drawerOpen, widthClass } = state;
  if (!route) return;

  // Full-screen pages cover the panes; the panes keep the last mailbox.
  const mailboxRoute = route.name === 'mailbox' ? route : state.lastMailboxRoute;
  page.hidden = route.name === 'mailbox';
  if (route.name === 'settings') renderSettings(page);

  const modalDrawer = isDrawerModal(widthClass);
  app.toggleAttribute('data-drawer-open', drawerOpen && modalDrawer);
  drawer.inert = modalDrawer && !drawerOpen;
  if (drawerOpen && modalDrawer && !unregisterDrawer) {
    unregisterDrawer = router.pushOverlay(() => setDrawerOpen(false));
  } else if (!(drawerOpen && modalDrawer) && unregisterDrawer) {
    unregisterDrawer();
    unregisterDrawer = null;
  }

  if (route !== previous.route || widthClass !== previous.widthClass) {
    renderDrawer(drawer, { route });
  }

  if (mailboxRoute) {
    app.toggleAttribute('data-has-thread', Boolean(mailboxRoute.threadId));
    if (mailboxRoute !== previous.lastMailboxRoute || state.online !== previous.online) {
      renderMailbox(listPane, { route: mailboxRoute, online: state.online });
      renderThread(readingPane, { route: mailboxRoute });
    }
  }
}

store.subscribe(renderApp);

// Delegated UI actions.
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target?.dataset.action === 'open-drawer') setDrawerOpen(true);
  if (target?.dataset.action === 'back') router.back();
  // Also covers tapping the current destination, where no hashchange fires.
  if (event.target.closest('.nav__item')) setDrawerOpen(false);
});
scrim.addEventListener('click', () => setDrawerOpen(false));

applyAccent(document.documentElement);
watchColorScheme({ store });
watchWidthClass({ root: app, store });
router.start();
await initPlatform({ router, store });
