import { html, icon, render } from '../html.js';
import { buildHash, UNIFIED_INBOX } from '../router.js';

const ROLE_ICONS = {
  inbox: 'inbox',
  sent: 'send',
  drafts: 'draft',
  trash: 'delete',
  archive: 'archive',
  junk: 'report',
  flagged: 'star',
  all: 'mail',
};

function folderLabel(folder) {
  if (folder.role === 'inbox') return 'Inbox';
  // Show nested folders by their leaf name, indented by depth.
  return folder.name;
}

function depthOf(folder) {
  if (!folder.delimiter || folder.role) return 0;
  return folder.path.split(folder.delimiter).length - 1;
}

function unreadBadge(count) {
  return count > 0 ? html`<span class="nav__badge">${count > 999 ? '999+' : count}</span>` : '';
}

export function renderDrawer(element, { route, accounts, folders }) {
  const currentFolder = route.name === 'mailbox' ? String(route.folderId) : null;
  const unifiedUnread = folders.filter((f) => f.role === 'inbox').reduce((sum, f) => sum + f.unreadCount, 0);

  const navItem = (href, iconName, label, current, extra = '') => html`
    <li>
      <a class="nav__item" href="${href}" aria-current="${current ? 'page' : 'false'}">
        ${icon(iconName)}<span class="nav__label">${label}</span>${extra}
      </a>
    </li>
  `;

  render(
    element,
    html`
      <h2 class="nav__heading nav__heading--app">Dispatch</h2>
      <ul class="nav__list">
        ${navItem(
          buildHash({ name: 'mailbox', folderId: UNIFIED_INBOX }),
          'inbox',
          'Unified Inbox',
          currentFolder === UNIFIED_INBOX,
          unreadBadge(unifiedUnread),
        )}
      </ul>
      ${accounts.map(
        (account) => html`
          <section class="nav__account" style="--account-accent: ${account.accentColor}">
            <h2 class="nav__heading nav__heading--account">
              <span class="nav__dot" aria-hidden="true"></span>${account.displayName || account.email}
            </h2>
            <ul class="nav__list">
              ${folders
                .filter((f) => f.accountId === account.id && f.selectable)
                .map(
                  (folder) => html`
                    <li style="--depth: ${depthOf(folder)}">
                      <a
                        class="nav__item"
                        href="${buildHash({ name: 'mailbox', folderId: String(folder.id) })}"
                        aria-current="${currentFolder === String(folder.id) ? 'page' : 'false'}"
                      >
                        ${icon(ROLE_ICONS[folder.role] ?? 'folder')}
                        <span class="nav__label">${folderLabel(folder)}</span>
                        ${unreadBadge(folder.role === 'sent' || folder.role === 'drafts' ? 0 : folder.unreadCount)}
                      </a>
                    </li>
                  `,
                )}
            </ul>
          </section>
        `,
      )}
      <ul class="nav__list nav__list--footer">
        ${navItem('#/accounts/new', 'add', 'Add account', route.name === 'accountSetup')}
        ${navItem('#/settings', 'settings', 'Settings', route.name === 'settings')}
      </ul>
    `,
  );
}
