import { html, icon, render } from '../html.js';
import { UNIFIED_INBOX } from '../router.js';

function folderTitle(folderId) {
  return folderId === UNIFIED_INBOX ? 'Unified Inbox' : folderId;
}

export function renderMailbox(element, { route, online }) {
  render(
    element,
    html`
      <header class="app-bar">
        <button class="icon-button app-bar__menu" type="button" data-action="open-drawer">
          ${icon('menu', 'Open navigation')}
        </button>
        <h1 class="app-bar__title">${folderTitle(route.folderId)}</h1>
        <button class="icon-button" type="button" data-action="search" disabled>
          ${icon('search', 'Search')}
        </button>
      </header>
      <div class="pane__body">
        <dm-empty-state
          icon="mail"
          heading="No accounts yet"
          message="${online ? 'Add an IMAP account to start receiving mail.' : 'You are offline.'}"
          action-label="Add account"
          action-href="#/settings"
        ></dm-empty-state>
      </div>
    `,
  );
}
