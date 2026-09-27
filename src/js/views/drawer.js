import { html, icon, render } from '../html.js';
import { buildHash, UNIFIED_INBOX } from '../router.js';

export function renderDrawer(element, { route }) {
  const inUnified = route.name === 'mailbox' && route.folderId === UNIFIED_INBOX;
  const inSettings = route.name === 'settings';

  render(
    element,
    html`
      <h2 class="nav__heading">Despatch Mobile</h2>
      <ul class="nav__list">
        <li>
          <a
            class="nav__item"
            href="${buildHash({ name: 'mailbox', folderId: UNIFIED_INBOX })}"
            aria-current="${inUnified ? 'page' : 'false'}"
          >
            ${icon('inbox')} Unified Inbox
          </a>
        </li>
      </ul>
      <h2 class="nav__heading">Accounts</h2>
      <ul class="nav__list">
        <li>
          <a class="nav__item" href="#/settings" aria-current="${inSettings ? 'page' : 'false'}">
            ${icon('settings')} Settings
          </a>
        </li>
      </ul>
    `,
  );
}
