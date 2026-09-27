# Despatch Mobile

A native Android IMAP email client built with HTML5, CSS3 and vanilla JavaScript, packaged with [Capacitor](https://capacitorjs.com/). Requires Android 16 (API 36) or later.

See [PLAN.md](PLAN.md) for the full implementation plan and milestones.

## Requirements

- Node.js 24+
- Android Studio (its bundled JDK 25 runs the Gradle 9.1 wrapper) and the Android SDK platform 36

## Development

```sh
npm install
npm run dev      # web build at http://localhost:5173 (Escape stands in for Android back)
npm test         # JS unit tests (Vitest)
npm run lint     # ESLint
```

## Android

```sh
npm run sync           # build the web app and copy it into android/
npm run android:open   # open the project in Android Studio
```

To build a debug APK from the command line, point `JAVA_HOME` at Android Studio's JDK first:

```sh
export JAVA_HOME="/f/Program Files/Android/Android Studio/jbr"
npm run android:debug  # android/app/build/outputs/apk/debug/app-debug.apk
```

Native unit tests run the IMAP/SMTP code against an in-process [GreenMail](https://greenmail-mail-test.github.io/greenmail/) server:

```sh
cd android && ./gradlew testDebugUnitTest
```

## Mail plugin

IMAP and SMTP need raw sockets, which a WebView can't open, so they live in a small Kotlin plugin, `DespatchMail` (`android/app/src/main/java/com/despatch/mobile/mail/`), built on [Angus Mail](https://eclipse-ee4j.github.io/angus-mail/). JS calls it through `src/js/mail/bridge.js`:

```js
import { mail } from './mail/bridge.js';

await mail.testConnection(account, { password });  // before saving
await mail.setCredentials(account.id, password);     // encrypted with an Android Keystore key
const folders = await mail.listFolders(account);
const latest = await mail.fetchEnvelopes(account, 'INBOX', { latest: 50 });
```

Passwords go in through `setCredentials` and are never returned to JS. Errors reject with a `MailError` whose `code` is one of `MailErrorCode` (for example `APP_PASSWORD_REQUIRED`). In a browser, `src/js/mail/web-mail.js` provides an in-memory mailbox with sample messages; the password `wrong` is always rejected.

## Accounts, storage and sync

- **Setup** (`src/js/accounts/setup.js`): known providers (Gmail, iCloud, Yahoo, AOL, Fastmail, Zoho) are configured without any lookup, and the wizard explains their app passwords. Other domains use the domain's own autoconfig, then Mozilla's ISPDB, then MX records (DNS over HTTPS), then a guess the user can edit. The password is saved only after a connection test succeeds. Outlook.com and Microsoft 365 are refused with a note that they arrive in v2.0.
- **Database** (`src/js/db/`): SQLite, encrypted with SQLCipher on Android (the passphrase is generated once and held by the plugin in Android's encrypted storage). The browser build uses sql.js persisted to IndexedDB, unencrypted, for development only. Schema changes go in `migrations.js` as new versions.
- **Sync** (`src/js/mail/sync.js`, `sync-manager.js`): Inbox and Sent sync on start, on resume, when the network returns and every 5 minutes while open. Other folders sync when opened. Each sync fetches only new UIDs, refreshes flags, removes expunged messages, handles UIDVALIDITY resets, and skips unchanged folders with CONDSTORE.

In development builds, `window.despatch` exposes `{ db, store, mail, syncManager }` for the console.

Bridge logging is off (`loggingBehavior: "none"` in `capacitor.config.json`) because Capacitor would otherwise write plugin arguments, including passwords, to logcat in debug builds.

## Project layout

| Path | Contents |
|---|---|
| `src/index.html` | App shell: drawer, list pane, reading pane, full-screen page |
| `src/css/` | Design tokens (system light/dark via `light-dark()`, per-account `--accent`), layout, components |
| `src/js/router.js` | Hash router that knows about panes, with deterministic back navigation |
| `src/js/layout.js` | Window width classes (compact / medium / expanded / large) |
| `src/js/theme/` | Accent colour and contrast handling |
| `src/js/views/` | Views and custom elements |
| `src/js/mail/` | Mail plugin bridge, in-memory web implementation, discovery, sync |
| `src/js/db/` | Database drivers, migrations and repositories |
| `src/js/accounts/` | Add-account flow |
| `android/` | Capacitor Android project (minSdk and targetSdk 36) |
| `tests/` | Vitest unit tests |
