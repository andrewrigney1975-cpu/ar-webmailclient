import { html, icon, render } from '../html.js';
import { formatFullDate } from '../util/format.js';

function status(sync) {
  if (!sync) return 'Not synced yet';
  if (sync.state === 'syncing') return 'Syncing…';
  if (sync.state === 'error') return sync.error?.message ?? 'Sync failed';
  return sync.lastSyncedAt ? `Synced ${formatFullDate(sync.lastSyncedAt)}` : 'Not synced yet';
}

export function renderSettings(element, { accounts, sync, confirmRemoveId, settings }) {
  render(
    element,
    html`
      <header class="app-bar">
        <button class="icon-button" type="button" data-action="back">${icon('back', 'Back')}</button>
        <h1 class="app-bar__title">Settings</h1>
      </header>
      <div class="pane__body settings">
        <h2 class="settings__heading">Accounts</h2>
        <ul class="account-list" role="list">
          ${accounts.map(
            (account) => html`
              <li class="account-card" style="--account-accent: ${account.accentColor}">
                <span class="account-card__dot" aria-hidden="true"></span>
                <div class="account-card__text">
                  <p class="account-card__email">${account.email}</p>
                  <p class="account-card__detail">${account.imap.host}</p>
                  <p class="account-card__status${sync[account.id]?.state === 'error' ? ' account-card__status--error' : ''}">
                    ${status(sync[account.id])}
                  </p>
                </div>
                <button
                  class="text-button${confirmRemoveId === account.id ? ' text-button--danger' : ''}"
                  type="button"
                  data-action="remove-account"
                  data-account-id="${account.id}"
                >
                  ${confirmRemoveId === account.id ? 'Tap again to remove' : 'Remove'}
                </button>
              </li>
            `,
          )}
        </ul>
        <a class="button settings__add" href="#/accounts/new">${icon('add')} Add account</a>
        <p class="settings__note">
          Removing an account deletes its saved mail and password from this device. Nothing is deleted on the server.
        </p>

        <h2 class="settings__heading">Reading</h2>
        <label class="switch-row">
          <span>
            <span class="switch-row__label">Group into conversations</span>
            <span class="switch-row__detail">Show replies together, including your own from Sent.</span>
          </span>
          <input class="switch" type="checkbox" role="switch" data-action="toggle-setting" data-setting="threading"
            ${settings.threading ? 'checked' : ''} />
        </label>
      </div>
    `,
  );
}
