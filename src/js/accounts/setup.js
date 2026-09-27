/**
 * Adding an account: discover settings, test the connection with the password
 * the user typed, and only then save the password (Keystore) and the account (DB).
 * UI lives in views/account-setup.js.
 */
import { insertAccount } from '../db/repo-accounts.js';
import { MailErrorCode } from '../mail/bridge.js';
import { domainOf, providerForDomain } from '../mail/providers.js';
import { pickDefaultAccent } from '../theme/accents.js';

export class SetupError extends Error {
  /**
   * @param {string} code  a MailErrorCode, or DUPLICATE_ACCOUNT / INVALID_EMAIL
   * @param {object} context  { provider, settings } so the UI can offer the right fix
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
    this.provider = context.provider ?? null;
    this.settings = context.settings ?? null;
  }
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * @param {object} options
 * @param {object} [options.settings]  manual { imap, smtp } settings; skips discovery
 */
export async function addAccount(
  { email, displayName, password, settings = null },
  { db, mail, discover, existingAccounts, newId = () => crypto.randomUUID() },
) {
  const address = email.trim().toLowerCase();
  if (!isValidEmail(address)) throw new SetupError('INVALID_EMAIL', 'Enter a valid email address.');

  let provider = providerForDomain(domainOf(address));
  let resolved = settings;
  if (!resolved) {
    const discovered = await discover(address);
    provider = discovered?.provider ?? provider;
    if (provider?.unsupportedUntil) {
      throw new SetupError(MailErrorCode.BASIC_AUTH_DISABLED, unsupportedMessage(provider), { provider });
    }
    resolved = discovered && { imap: discovered.imap, smtp: discovered.smtp, source: discovered.source };
  }

  if (existingAccounts.some((a) => a.email === address && a.imap.host === resolved.imap.host)) {
    throw new SetupError('DUPLICATE_ACCOUNT', 'This account has already been added.', { provider, settings: resolved });
  }

  const dynamicColors = await mail.getDynamicColors().catch(() => []);
  const account = {
    id: newId(),
    email: address,
    displayName: displayName?.trim() || null,
    imap: resolved.imap,
    smtp: resolved.smtp ?? null,
    accentColor: pickDefaultAccent(existingAccounts.map((a) => a.accentColor), dynamicColors),
    signature: null,
  };

  try {
    await mail.testConnection(account, { password });
  } catch (error) {
    throw new SetupError(error.code ?? MailErrorCode.SERVER_ERROR, error.message, { provider, settings: resolved });
  }

  await mail.setCredentials(account.id, password);
  await insertAccount(db, account);
  return account;
}

function unsupportedMessage(provider) {
  return `${provider.name} has turned off password sign-in for other mail apps. Support is planned for Despatch Mobile ${provider.unsupportedUntil}.`;
}

/** Turns a SetupError into text for the wizard. `showManual` means the server settings form should open. */
export function describeSetupError(error) {
  const provider = error.provider;
  const host = error.settings?.imap?.host;
  switch (error.code) {
    case 'INVALID_EMAIL':
      return { title: 'Check the email address', message: error.message, showManual: false };
    case 'DUPLICATE_ACCOUNT':
      return { title: 'Already added', message: error.message, showManual: false };
    case 'PLAINTEXT':
      return { title: 'Confirm insecure connection', message: error.message, showManual: true };
    case MailErrorCode.BASIC_AUTH_DISABLED:
      return {
        title: 'Not supported yet',
        message: provider ? unsupportedMessage(provider) : error.message,
        showManual: false,
      };
    case MailErrorCode.APP_PASSWORD_REQUIRED:
      return {
        title: 'Use an app password',
        message: provider?.appPassword?.steps ?? 'This provider needs an app password instead of your normal password.',
        showManual: false,
      };
    case MailErrorCode.AUTH_FAILED:
      return provider?.appPassword && !provider.appPassword.optional
        ? {
            title: 'Password not accepted',
            // The steps are already shown in the provider hint above the error.
            message: `${provider.name} needs an app password, not your normal password.`,
            showManual: false,
          }
        : { title: 'Password not accepted', message: 'Check your username and password.', showManual: true };
    case MailErrorCode.CONNECTION_FAILED:
    case MailErrorCode.TIMEOUT:
      return {
        title: "Couldn't reach the server",
        message: host ? `Check the server name (${host}) and port.` : 'Check the server settings.',
        showManual: true,
      };
    case MailErrorCode.TLS_FAILED:
      return {
        title: 'Secure connection failed',
        message: 'The server’s certificate could not be verified, or it doesn’t support this security setting.',
        showManual: true,
      };
    default:
      return { title: 'Something went wrong', message: error.message, showManual: true };
  }
}
