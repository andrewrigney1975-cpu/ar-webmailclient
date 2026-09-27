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
npm test         # unit tests (Vitest)
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

## Project layout

| Path | Contents |
|---|---|
| `src/index.html` | App shell: drawer, list pane, reading pane, full-screen page |
| `src/css/` | Design tokens (system light/dark via `light-dark()`, per-account `--accent`), layout, components |
| `src/js/router.js` | Hash router that knows about panes, with deterministic back navigation |
| `src/js/layout.js` | Window width classes (compact / medium / expanded / large) |
| `src/js/theme/` | Accent colour and contrast handling |
| `src/js/views/` | Views and custom elements |
| `android/` | Capacitor Android project (minSdk and targetSdk 36) |
| `tests/` | Vitest unit tests |
