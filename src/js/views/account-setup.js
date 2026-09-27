/**
 * Add-account wizard (PLAN.md §4.1). One screen with email, name and
 * password; server settings appear only when discovery or the connection
 * test needs the user's help. Logic lives in accounts/setup.js.
 */
import { html, icon, render } from '../html.js';
import { describeSetupError, SetupError } from '../accounts/setup.js';
import { domainOf, providerForDomain } from '../mail/providers.js';

const SECURITY_OPTIONS = [
  ['tls', 'SSL/TLS'],
  ['starttls', 'STARTTLS'],
  ['none', 'None (insecure)'],
];

const DEFAULT_PORTS = {
  imap: { tls: 993, starttls: 143, none: 143 },
  smtp: { tls: 465, starttls: 587, none: 25 },
};

function blankSettings(email) {
  const domain = domainOf(email) || 'example.com';
  return {
    imap: { host: `imap.${domain}`, port: 993, security: 'tls', username: email },
    smtp: { host: `smtp.${domain}`, port: 465, security: 'tls', username: email },
  };
}

function providerHint(provider) {
  if (!provider) return '';
  if (provider.unsupportedUntil) {
    return html`<div class="banner banner--warning">
      ${icon('error')}
      <p>${provider.name} accounts can’t be added yet. Support is planned for Despatch Mobile ${provider.unsupportedUntil}.</p>
    </div>`;
  }
  if (!provider.appPassword) return '';
  return html`<div class="banner banner--info">
    ${icon('error')}
    <div>
      <p><strong>${provider.name} ${provider.appPassword.optional ? 'may need' : 'needs'} an app password.</strong></p>
      <p>${provider.appPassword.steps}</p>
      <button class="text-button" type="button" data-action="open-url" data-url="${provider.appPassword.url}">
        Create app password ${icon('open')}
      </button>
    </div>
  </div>`;
}

function serverFields(kind, server) {
  const label = kind === 'imap' ? 'Incoming mail (IMAP)' : 'Outgoing mail (SMTP)';
  return html`
    <fieldset class="field-group">
      <legend>${label}</legend>
      <label class="field">
        <span>Server</span>
        <input name="${kind}.host" value="${server.host}" autocapitalize="off" autocorrect="off" spellcheck="false" required />
      </label>
      <div class="field-row">
        <label class="field">
          <span>Security</span>
          <select name="${kind}.security" data-kind="${kind}">
            ${SECURITY_OPTIONS.map(
              ([value, text]) => html`<option value="${value}" ${server.security === value ? 'selected' : ''}>${text}</option>`,
            )}
          </select>
        </label>
        <label class="field field--port">
          <span>Port</span>
          <input name="${kind}.port" value="${server.port}" inputmode="numeric" pattern="[0-9]+" required />
        </label>
      </div>
      <label class="field">
        <span>Username</span>
        <input name="${kind}.username" value="${server.username}" autocapitalize="off" autocorrect="off" spellcheck="false" required />
      </label>
    </fieldset>
  `;
}

export function createAccountSetupView({ element, onSubmit, onOpenUrl, onDone }) {
  let state = {
    email: '',
    displayName: '',
    password: '',
    manual: false,
    settings: null,
    busy: false,
    error: null,
  };

  function readForm(form) {
    const data = new FormData(form);
    state.email = String(data.get('email') ?? '').trim();
    state.displayName = String(data.get('displayName') ?? '');
    state.password = String(data.get('password') ?? '');
    if (state.manual) {
      const server = (kind) => ({
        host: String(data.get(`${kind}.host`)).trim(),
        port: Number(data.get(`${kind}.port`)),
        security: String(data.get(`${kind}.security`)),
        username: String(data.get(`${kind}.username`)).trim(),
      });
      state.settings = { imap: server('imap'), smtp: server('smtp') };
    }
  }

  function usesPlaintext() {
    return state.manual && [state.settings?.imap, state.settings?.smtp].some((s) => s?.security === 'none');
  }

  function draw() {
    const provider = providerForDomain(domainOf(state.email));
    const described = state.error && describeSetupError(state.error);
    render(
      element,
      html`
        <header class="app-bar">
          <button class="icon-button" type="button" data-action="back">${icon('back', 'Back')}</button>
          <h1 class="app-bar__title">Add account</h1>
        </header>
        <form class="pane__body setup" novalidate>
          <p class="setup__intro">Despatch Mobile works with any IMAP email account.</p>
          <label class="field">
            <span>Email address</span>
            <input name="email" type="email" value="${state.email}" autocomplete="email" autocapitalize="off" required />
          </label>
          <label class="field">
            <span>Your name <small>(shown to people you email)</small></span>
            <input name="displayName" value="${state.displayName}" autocomplete="name" />
          </label>
          <label class="field">
            <span>Password or app password</span>
            <input name="password" type="password" value="${state.password}" autocomplete="current-password" required />
          </label>
          <div class="setup__hint">${providerHint(provider)}</div>

          ${described
            ? html`<div class="banner banner--error" role="alert">
                ${icon('error')}
                <div><p><strong>${described.title}</strong></p><p>${described.message}</p></div>
              </div>`
            : ''}

          ${state.manual
            ? html`
                ${serverFields('imap', state.settings.imap)} ${serverFields('smtp', state.settings.smtp)}
                ${usesPlaintext()
                  ? html`<label class="checkbox">
                      <input type="checkbox" name="allowPlaintext" required />
                      <span>I understand my password and mail will be sent without encryption.</span>
                    </label>`
                  : ''}
              `
            : html`<button class="text-button" type="button" data-action="manual-setup">Set up manually</button>`}

          <div class="setup__actions">
            <button class="button" type="submit" ${state.busy ? 'disabled' : ''}>
              ${state.busy ? 'Checking…' : 'Sign in'}
            </button>
          </div>
        </form>
      `,
    );
  }

  element.addEventListener('input', (event) => {
    if (event.target.name === 'email') {
      state.email = event.target.value.trim();
      const hint = element.querySelector('.setup__hint');
      if (hint) render(hint, providerHint(providerForDomain(domainOf(state.email))));
    }
  });

  element.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-kind]');
    if (!select) return;
    // Switching security mode switches to that mode's usual port.
    const kind = select.dataset.kind;
    readForm(select.form);
    state.settings[kind].port = DEFAULT_PORTS[kind][select.value];
    draw();
  });

  element.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action?.dataset.action === 'manual-setup') {
      readForm(action.closest('form'));
      state.manual = true;
      state.settings = state.settings ?? blankSettings(state.email);
      draw();
    }
    if (action?.dataset.action === 'open-url') onOpenUrl(action.dataset.url);
  });

  element.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    readForm(form);
    if (usesPlaintext() && !form.elements.allowPlaintext?.checked) {
      state.error = new SetupError('PLAINTEXT', 'Confirm that you want to connect without encryption.');
      draw();
      return;
    }

    state.busy = true;
    state.error = null;
    draw();
    try {
      const account = await onSubmit({
        email: state.email,
        displayName: state.displayName,
        password: state.password,
        settings: state.manual ? state.settings : null,
      });
      state = { ...state, password: '', busy: false };
      onDone(account);
    } catch (error) {
      state.busy = false;
      state.error = error;
      if (error instanceof SetupError && describeSetupError(error).showManual) {
        state.manual = true;
        state.settings = state.settings ?? error.settings ?? blankSettings(state.email);
      }
      draw();
    }
  });

  return {
    /** Shows a fresh form. */
    reset() {
      state = { email: '', displayName: '', password: '', manual: false, settings: null, busy: false, error: null };
      draw();
    },
  };
}
