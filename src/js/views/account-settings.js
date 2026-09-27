/**
 * One account's settings: display name, signature, accent colour (PLAN.md
 * §4.5) and password (for when an app password is revoked or replaced).
 */
import { html, icon, render } from '../html.js';
import { updateAccount } from '../db/repo-accounts.js';
import { describeSetupError, SetupError } from '../accounts/setup.js';
import { FALLBACK_PALETTE } from '../theme/accents.js';
import { isValidHex, onColorFor } from '../theme/theme.js';

export function createAccountSettingsView({ element, db, store, mail, snackbar, onSaved, onPasswordChanged }) {
  let accountId = null;
  let dynamicColors = [];
  let passwordError = null;
  let checking = false;

  const account = () => store.get().accounts.find((a) => a.id === accountId);

  function swatches(current) {
    const colors = [...new Set([...dynamicColors, ...FALLBACK_PALETTE].map((c) => c.toLowerCase()))];
    if (!colors.includes(current.toLowerCase())) colors.unshift(current.toLowerCase());
    return html`${colors.map(
      (color) => html`<button class="swatch" type="button" data-accent="${color}" style="--swatch: ${color}; --on-swatch: ${onColorFor(color)}"
        aria-pressed="${String(color === current.toLowerCase())}" aria-label="Accent ${color}">
        ${color === current.toLowerCase() ? icon('check') : ''}
      </button>`,
    )}`;
  }

  function draw() {
    const a = account();
    if (!a) {
      render(element, html`<div class="pane__body"><dm-empty-state icon="settings" heading="Account not found"></dm-empty-state></div>`);
      return;
    }
    const error = passwordError && describeSetupError(passwordError);
    render(
      element,
      html`
        <header class="app-bar">
          <button class="icon-button" type="button" data-action="back">${icon('back', 'Back')}</button>
          <h1 class="app-bar__title">${a.email}</h1>
        </header>
        <form class="pane__body settings account-settings" novalidate autocomplete="off" style="--account-accent: ${a.accentColor}">
          <h2 class="settings__heading">Sending</h2>
          <label class="field">
            <span>Your name</span>
            <input name="displayName" value="${a.displayName ?? ''}" autocomplete="name" />
          </label>
          <label class="field">
            <span>Signature <small>(added to new messages and replies)</small></span>
            <textarea name="signature" rows="4">${a.signature ?? ''}</textarea>
          </label>

          <div class="settings-group">
          <label class="switch-row">
            <span>
              <span class="switch-row__label">Notify me about new mail</span>
              <span class="switch-row__detail">For this account’s Inbox.</span>
            </span>
            <input class="switch" type="checkbox" role="switch" name="notify" ${a.notify ? 'checked' : ''} />
          </label>
          </div>

          <h2 class="settings__heading">Accent colour</h2>
          <div class="swatches" role="group" aria-label="Accent colour">${swatches(a.accentColor)}</div>
          <label class="field field--inline">
            <span>Custom</span>
            <input type="color" name="customAccent" value="${a.accentColor}" />
          </label>

          <h2 class="settings__heading">Password</h2>
          <p class="settings__note">If you replaced or revoked the app password, enter the new one here. It’s checked with the server before it’s saved.</p>
          <label class="field">
            <span>New password or app password</span>
            <input type="password" name="password" autocomplete="new-password" />
          </label>
          ${error
            ? html`<div class="banner banner--error" role="alert">${icon('error')}<div><p><strong>${error.title}</strong></p><p>${error.message}</p></div></div>`
            : ''}
          <div class="setup__actions">
            <button class="button" type="button" data-account="password" ${checking ? 'disabled' : ''}>
              ${checking ? 'Checking…' : 'Update password'}
            </button>
          </div>

          <h2 class="settings__heading">Server</h2>
          <p class="settings__note">Incoming: ${a.imap.host}:${a.imap.port} (${a.imap.security})<br />
            Outgoing: ${a.smtp ? `${a.smtp.host}:${a.smtp.port} (${a.smtp.security})` : 'none'}</p>
        </form>
      `,
    );
  }

  async function save(patch) {
    await updateAccount(db, accountId, patch);
    await onSaved();
  }

  async function changePassword() {
    const input = element.querySelector('[name=password]');
    const password = input.value;
    if (!password) return;
    checking = true;
    passwordError = null;
    draw();
    try {
      await mail.testConnection(account(), { password });
      await mail.setCredentials(accountId, password);
      await mail.disconnect(accountId);
      snackbar.show('Password updated.');
      onPasswordChanged(account());
    } catch (error) {
      passwordError = new SetupError(error.code, error.message, { settings: account() });
    } finally {
      checking = false;
      draw();
    }
  }

  element.addEventListener('change', (event) => {
    const field = event.target;
    if (!accountId || !field.name) return;
    if (field.name === 'displayName') save({ displayName: field.value.trim() || null });
    if (field.name === 'signature') save({ signature: field.value.trim() || null });
    if (field.name === 'notify') save({ notify: field.checked });
    if (field.name === 'customAccent' && isValidHex(field.value)) save({ accentColor: field.value }).then(draw);
  });
  element.addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-accent]');
    if (swatch) save({ accentColor: swatch.dataset.accent }).then(draw);
    if (event.target.closest('[data-account=password]')) changePassword();
  });

  return {
    async open(id) {
      accountId = id;
      passwordError = null;
      draw();
      dynamicColors = await mail.getDynamicColors().catch(() => []);
      if (accountId === id) draw();
    },
    close() {
      // Commit a field that's still focused (change fires on blur).
      document.activeElement?.blur?.();
      accountId = null;
    },
  };
}
