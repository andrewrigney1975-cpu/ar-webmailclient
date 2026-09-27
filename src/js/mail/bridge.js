/**
 * JS side of the DespatchMail native plugin (android/.../mail/DespatchMailPlugin.kt).
 *
 * Passwords go in through `setCredentials` and are stored in the Android
 * Keystore; they are never read back into JS. Every other call identifies the
 * account by its settings, and native code looks the password up itself.
 *
 * In a browser the in-memory implementation in web-mail.js is used instead.
 */
import { registerPlugin } from '@capacitor/core';

export const DespatchMail = registerPlugin('DespatchMail', {
  web: () => import('./web-mail.js').then((module) => new module.DespatchMailWeb()),
});

/** Error codes, matching MailErrorCode in MailErrors.kt. */
export const MailErrorCode = Object.freeze({
  AUTH_FAILED: 'AUTH_FAILED',
  APP_PASSWORD_REQUIRED: 'APP_PASSWORD_REQUIRED',
  BASIC_AUTH_DISABLED: 'BASIC_AUTH_DISABLED',
  NO_CREDENTIALS: 'NO_CREDENTIALS',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  TLS_FAILED: 'TLS_FAILED',
  TIMEOUT: 'TIMEOUT',
  FOLDER_NOT_FOUND: 'FOLDER_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  RECIPIENT_REJECTED: 'RECIPIENT_REJECTED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NO_APP: 'NO_APP',
  UNSUPPORTED: 'UNSUPPORTED',
  SERVER_ERROR: 'SERVER_ERROR',
});

export class MailError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailError';
    this.code = code;
  }
}

function toMailError(error) {
  if (error instanceof MailError) return error;
  const code = Object.hasOwn(MailErrorCode, error?.code) ? error.code : MailErrorCode.SERVER_ERROR;
  return new MailError(code, error?.message ?? String(error));
}


function server(config) {
  return config && { host: config.host, port: config.port, security: config.security, username: config.username };
}

/** Only the connection settings cross the bridge, not UI settings such as the accent colour. */
export function toNativeAccount(account) {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName ?? null,
    imap: server(account.imap),
    smtp: server(account.smtp) ?? null,
  };
}

/**
 * @typedef {{ uids: number[] } | { fromUid: number, toUid?: number | null } | { latest: number }} MessageQuery
 */

/** Wraps a DespatchMail plugin instance. Tests pass the in-memory web implementation directly. */
export function createMailApi(plugin) {
  async function call(method, options) {
    try {
      return await plugin[method](options);
    } catch (error) {
      throw toMailError(error);
    }
  }

  return {
    setCredentials: (accountId, password) => call('setCredentials', { accountId, password }),
    deleteCredentials: (accountId) => call('deleteCredentials', { accountId }),
    hasCredentials: async (accountId) => (await call('hasCredentials', { accountId })).value,

    /** Checks IMAP (and SMTP when configured). `password` lets the setup wizard test before saving. */
    testConnection: (account, { password } = {}) =>
      call('testConnection', { account: toNativeAccount(account), password }),

    disconnect: (accountId) => call('disconnect', { accountId }),

    // --- Notifications (native background checking, PLAN.md §4.4) ---

    configureBackgroundSync: (config) => call('configureBackgroundSync', config),
    markNotified: ({ accountId, uidValidity, uid }) => call('markNotified', { accountId, uidValidity, uid }),
    /** { permission: 'granted' | 'denied' | 'prompt' | …, enabled } */
    notificationStatus: () => call('notificationStatus', {}),
    openNotificationSettings: () => call('openNotificationSettings', {}),
    requestNotificationPermission: async () =>
      (await plugin.requestPermissions({ permissions: ['notifications'] })).notifications,
    /** Calls back with { action: 'open' | 'reply', accountId, path, uid } when a notification is tapped. */
    addNotificationListener: (callback) => plugin.addListener('notificationTapped', callback),

    /** Material You wallpaper colours (empty in the browser). */
    getDynamicColors: async () => (await call('getDynamicColors', {})).colors,

    listFolders: async (account) => (await call('listFolders', { account: toNativeAccount(account) })).folders,

    folderStatus: (account, path) => call('folderStatus', { account: toNativeAccount(account), path }),

    /** @param {MessageQuery} query */
    fetchEnvelopes: async (account, path, query) =>
      (await call('fetchEnvelopes', { account: toNativeAccount(account), path, query })).messages,

    /** @param {MessageQuery} query */
    fetchFlags: async (account, path, query) =>
      (await call('fetchFlags', { account: toNativeAccount(account), path, query })).messages,

    fetchBody: (account, path, uid) => call('fetchBody', { account: toNativeAccount(account), path, uid }),

    /** Saves an attachment to the app cache and returns `{ path, size }`. */
    downloadAttachment: (account, path, uid, partId, filename) =>
      call('downloadAttachment', { account: toNativeAccount(account), path, uid, partId, filename }),

    setFlags: (account, path, uids, { add = [], remove = [] }) =>
      call('setFlags', { account: toNativeAccount(account), path, uids, add, remove }),

    moveMessages: async (account, path, uids, destination) =>
      (await call('moveMessages', { account: toNativeAccount(account), path, uids, destination })).newUids,

    /** IMAP SEARCH in one folder; returns matching UIDs, newest first. */
    searchServer: async (account, path, criteria) =>
      (await call('searchServer', { account: toNativeAccount(account), path, criteria })).uids,

    /** Permanently deletes messages (\Deleted + expunge). Used for "Delete forever" in Trash. */
    deleteMessages: (account, path, uids) =>
      call('deleteMessages', { account: toNativeAccount(account), path, uids }),

    /** Opens a downloaded attachment (a path from downloadAttachment) in another app. */
    openFile: (path, mimeType) => call('openFile', { path, mimeType }),

    /** Copies a cached file into Downloads. */
    saveToDownloads: (path, filename, mimeType) => call('saveToDownloads', { path, filename, mimeType }),

    /** Shares a downloaded attachment through the system share sheet. */
    shareFile: (path, mimeType, title) => call('shareFile', { path, mimeType, title }),

    /** Saves a draft to the Drafts folder, replacing `replaceUid`. Returns the new UID (or null). */
    saveDraft: async (account, message, { draftsFolder, replaceUid = null }) =>
      (await call('saveDraft', { account: toNativeAccount(account), message, draftsFolder, replaceUid })).uid ?? null,

    /**
     * Sends a message. With `sentFolder`, a copy is appended there; if that fails
     * the send still succeeds and `sentFolderError` holds the error code.
     */
    send: (account, message, { sentFolder } = {}) =>
      call('send', { account: toNativeAccount(account), message, sentFolder }),
  };
}

export const mail = createMailApi(DespatchMail);
