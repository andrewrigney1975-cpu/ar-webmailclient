import { html, icon, render } from '../html.js';
import { buildHash, UNIFIED_INBOX } from '../router.js';
import { displayName, formatListDate } from '../util/format.js';

function title(route, folder) {
  if (route.folderId === UNIFIED_INBOX) return 'Unified Inbox';
  if (!folder) return 'Folder';
  return folder.role === 'inbox' ? 'Inbox' : folder.name;
}

/** People shown in a row: recipients for Sent/Drafts, the sender otherwise. */
function correspondent(message, folder) {
  if (folder?.role === 'sent' || folder?.role === 'drafts') {
    const to = message.to.map(displayName).join(', ');
    return to ? `To: ${to}` : '(no recipients)';
  }
  return displayName(message.from);
}

function syncBanners(accounts, sync) {
  return accounts
    .filter((a) => sync[a.id]?.state === 'error')
    .map(
      (a) => html`
        <div class="banner banner--error" role="status">
          ${icon('error')}
          <p><strong>${a.email}</strong>: ${sync[a.id].error?.message ?? 'Sync failed.'}</p>
          <a class="banner__action" href="#/settings">Fix</a>
        </div>
      `,
    );
}

export function renderMailbox(element, { route, folder, messages, accounts, sync, online, now = Date.now() }) {
  const accentOf = new Map(accounts.map((a) => [a.id, a.accentColor]));
  const syncing = accounts.some((a) => sync[a.id]?.state === 'syncing');
  const showAccount = route.folderId === UNIFIED_INBOX && accounts.length > 1;

  let body;
  if (accounts.length === 0) {
    body = html`<dm-empty-state
      icon="mail"
      heading="No accounts yet"
      message="Add an IMAP account to start receiving mail."
      action-label="Add account"
      action-href="#/accounts/new"
    ></dm-empty-state>`;
  } else if (messages.length === 0) {
    body = html`<dm-empty-state
      icon="inbox"
      heading="${syncing ? 'Checking for mail…' : 'Nothing here'}"
      message="${syncing ? '' : 'This folder is empty.'}"
    ></dm-empty-state>`;
  } else {
    body = html`
      <ul class="message-list" role="list">
        ${messages.map(
          (m) => html`
            <li>
              <a
                class="message-row${m.isRead ? '' : ' message-row--unread'}${String(m.id) === route.threadId ? ' message-row--selected' : ''}"
                href="${buildHash({ ...route, threadId: String(m.id) })}"
                style="--row-accent: ${accentOf.get(m.accountId) ?? 'var(--accent)'}"
              >
                <span class="message-row__from">${correspondent(m, folder)}</span>
                <span class="message-row__date">${formatListDate(m.dateReceived ?? m.dateSent, now)}</span>
                <span class="message-row__subject">${m.subject || '(no subject)'}</span>
                <span class="message-row__icons">
                  ${m.hasAttachments ? icon('attach', 'Has attachments') : ''}
                  ${m.isFlagged ? icon('star', 'Flagged') : ''}
                </span>
                ${showAccount ? html`<span class="message-row__account" aria-hidden="true"></span>` : ''}
              </a>
            </li>
          `,
        )}
      </ul>
    `;
  }

  render(
    element,
    html`
      <header class="app-bar">
        <button class="icon-button app-bar__menu" type="button" data-action="open-drawer">
          ${icon('menu', 'Open navigation')}
        </button>
        <h1 class="app-bar__title">${title(route, folder)}</h1>
        <button
          class="icon-button${syncing ? ' icon-button--spinning' : ''}"
          type="button"
          data-action="refresh"
          ${accounts.length === 0 || !online ? 'disabled' : ''}
        >
          ${icon('refresh', 'Check for new mail')}
        </button>
      </header>
      ${online ? '' : html`<div class="banner" role="status">${icon('error')}<p>You’re offline. Showing saved mail.</p></div>`}
      ${syncBanners(accounts, sync)}
      <div class="pane__body">${body}</div>
    `,
  );
}
