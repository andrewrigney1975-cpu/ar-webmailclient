import { html, icon, render } from '../html.js';
import { formatFullDate } from '../util/format.js';

function status(sync) {
  if (!sync) return 'Not synced yet';
  if (sync.state === 'syncing') return 'Syncing…';
  if (sync.state === 'error') return sync.error?.message ?? 'Sync failed';
  return sync.lastSyncedAt ? `Synced ${formatFullDate(sync.lastSyncedAt)}` : 'Not synced yet';
}

function notificationSummary(status) {
  if (!status) return 'Checking…';
  if (status.permission === 'granted' && status.enabled) return 'On';
  if (status.permission === 'prompt' || status.permission === 'prompt-with-rationale') return 'Not allowed yet';
  return 'Blocked in Android settings';
}

export function renderSettings(element, { accounts, sync, confirmRemoveId, settings, notificationStatus }) {
  const allowed = notificationStatus?.permission === 'granted' && notificationStatus?.enabled;
  const askable = notificationStatus?.permission === 'prompt' || notificationStatus?.permission === 'prompt-with-rationale';
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
                <a class="account-card__text" href="#/account/${encodeURIComponent(account.id)}">
                  <p class="account-card__email">${account.email}</p>
                  <p class="account-card__detail">${account.imap.host}</p>
                  <p class="account-card__status${sync[account.id]?.state === 'error' ? ' account-card__status--error' : ''}">
                    ${status(sync[account.id])}
                  </p>
                </a>
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

        <h2 class="settings__heading">Notifications</h2>
        <div class="switch-row">
          <span>
            <span class="switch-row__label">New mail notifications: ${notificationSummary(notificationStatus)}</span>
            <span class="switch-row__detail">Turn them on or off for each account on its page.</span>
          </span>
          ${askable
            ? html`<button class="text-button" type="button" data-action="notification-permission">Allow</button>`
            : html`<button class="text-button" type="button" data-action="notification-settings">${allowed ? 'Android settings' : 'Open settings'}</button>`}
        </div>
        <label class="switch-row">
          <span>
            <span class="switch-row__label">Check for new mail</span>
            <span class="switch-row__detail">When the app isn’t open.</span>
          </span>
          <select class="settings__select" data-setting="syncIntervalMinutes">
            ${[15, 30, 60, 180].map(
              (minutes) => html`<option value="${minutes}" ${settings.syncIntervalMinutes === minutes ? 'selected' : ''}>
                ${minutes < 60 ? `Every ${minutes} minutes` : minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`}
              </option>`,
            )}
          </select>
        </label>
        <label class="switch-row">
          <span>
            <span class="switch-row__label">Instant notifications</span>
            <span class="switch-row__detail">Keeps a connection open so new mail shows at once. Uses more battery, and Android shows an ongoing notification.</span>
          </span>
          <input class="switch" type="checkbox" role="switch" data-action="toggle-setting" data-setting="instantNotifications"
            ${settings.instantNotifications ? 'checked' : ''} />
        </label>

        <h2 class="settings__heading">Reading</h2>
        <label class="switch-row">
          <span>
            <span class="switch-row__label">Group into conversations</span>
            <span class="switch-row__detail">Show replies together, including your own from Sent.</span>
          </span>
          <input class="switch" type="checkbox" role="switch" data-action="toggle-setting" data-setting="threading"
            ${settings.threading ? 'checked' : ''} />
        </label>
        <label class="switch-row">
          <span>
            <span class="switch-row__label">Dark message backgrounds</span>
            <span class="switch-row__detail">In dark mode, show emails with dark colours instead of on white.</span>
          </span>
          <input class="switch" type="checkbox" role="switch" data-action="toggle-setting" data-setting="darkMessages"
            ${settings.darkMessages ? 'checked' : ''} />
        </label>
      </div>
    `,
  );
}
