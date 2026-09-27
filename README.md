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

## Project layout

| Path | Contents |
|---|---|
| `src/index.html` | App shell: drawer, list pane, reading pane, full-screen page |
| `src/css/` | Design tokens (system light/dark via `light-dark()`, per-account `--accent`), layout, components |
| `src/js/router.js` | Hash router that knows about panes, with deterministic back navigation |
| `src/js/layout.js` | Window width classes (compact / medium / expanded / large) |
| `src/js/theme/` | Accent colour and contrast handling |
| `src/js/views/` | Views and custom elements |
| `src/js/mail/` | Mail plugin bridge and its in-memory web implementation |
| `android/` | Capacitor Android project (minSdk and targetSdk 36) |
| `tests/` | Vitest unit tests |
