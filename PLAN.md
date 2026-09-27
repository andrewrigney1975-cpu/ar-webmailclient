# Dispatch Mobile — Implementation Plan

A native Android email client built with HTML5, CSS3 and vanilla JavaScript (ES modules, no framework), packaged with Capacitor.

**Features:**
- Multiple IMAP accounts
- Threaded conversations
- Address autocomplete
- Notifications
- Search and sort
- A colour accent for each account that sits on top of the system light/dark theme
- Calendar events (`.ics`) created from dates found in messages
- Two-pane layout on tablets and foldables

**Target platform:** Android 16 (API 36) and later only. `minSdkVersion` and `targetSdkVersion` are both 36.

---

## 0. Decisions log

| # | Decision | Impact on the plan |
|---|---|---|
| D1 | **Minimum Android version is Android 16 (API 36)** | No compatibility code for older releases. The app can rely on modern WebView CSS/JS, Material You dynamic colour, predictive back, and enforced edge-to-edge. See §1a. |
| D2 | **v1.0 authenticates with passwords / app passwords only.** Gmail and Outlook/Exchange OAuth2 move to **v2.0** | The OAuth milestone and OAuth plugin are removed from v1. The setup wizard guides users to create app passwords. See §4.1 and §10. |
| D3 | **No direct write to the device calendar.** `.ics` export only | No `READ_CALENDAR` / `WRITE_CALENDAR` permission and no CalendarContract code. See §4.7. |
| D4 | **Tablet two-pane layout is in scope for v1** | A new adaptive layout section (§4.9) and a new milestone. Foldables and landscape phones are covered by the same layout. |

---

## 1. Key architectural decision: IMAP needs native code

A WebView can't open raw TCP/TLS sockets, so IMAP and SMTP can't run in JavaScript alone. The plan draws the line here:

| Layer | Technology | Responsibility |
|---|---|---|
| UI | HTML5 / CSS3 / vanilla JS (ES modules) | All screens, state, threading, search UI, ICS generation |
| Bridge | Capacitor (latest major that supports targetSdk 36) plugin API | Typed async calls and event listeners |
| Native (small, focused) | Kotlin custom plugin `DespatchMail` using **Angus Mail** (Jakarta Mail) | IMAP connect/fetch/IDLE, SMTP send, background sync worker |
| Storage | `@capacitor-community/sqlite` (SQLCipher-encrypted) with FTS5 | Local cache of messages, threads, contacts, search index |
| Secrets | Android Keystore via `capacitor-secure-storage-plugin` (or a Keystore call inside the custom plugin) | Passwords and OAuth tokens |

The Kotlin plugin is kept thin. It moves raw data (envelopes, BODYSTRUCTURE, MIME parts) to JS. Threading, sorting, date extraction and rendering stay in JS, so most of the app logic is web code as requested.

### Capacitor plugins
- `@capacitor/local-notifications`: new-mail notifications
- `@capacitor/filesystem` + `@capacitor/share`: `.ics` and attachment save/share
- `@capacitor/app`, `@capacitor/status-bar`, `@capacitor/keyboard`, `@capacitor/network`, `@capacitor/preferences`
- Custom: `DespatchMail` (IMAP/SMTP/sync), which registers a **WorkManager** periodic job for background fetch
- *(v2.0: an OAuth plugin for Gmail and Outlook/Exchange XOAUTH2. Not in v1.)*

---

## 1a. Platform baseline: Android 16 (API 36)

Supporting only Android 16 and later removes most compatibility work and lets the plan rely on:

- **A modern Chromium WebView.** CSS nesting, container queries, `:has()`, `color-mix()` / OKLCH, the `popover` attribute, View Transitions and `scrollbar-gutter` all work without fallbacks or polyfills. The JS ships untranspiled ES2023+.
- **Material You dynamic colour (always available).** The default accent for a new account is seeded from the system wallpaper palette, read through `DespatchMail.getDynamicColors()`.
- **Enforced edge-to-edge.** The layout uses `env(safe-area-inset-*)` plus insets forwarded from native code. The status and navigation bars are transparent, and system bar icon contrast follows the theme.
- **Predictive back gesture.** It is on by default for apps targeting API 36. The router registers with `OnBackPressedDispatcher` (through `@capacitor/app` `backButton`) so that panes and sheets close in order, with the system back preview animation.
- **Large-screen behaviour.** On displays at least 600dp wide, Android 16 ignores orientation and resizability locks for apps targeting API 36. The app must therefore be fully resizable, which the two-pane layout (§4.9) handles.
- **Runtime notification permission.** `POST_NOTIFICATIONS` must always be requested (see §4.4).
- **Foreground service types.** The optional IDLE "Push" service uses the `remoteMessaging` foreground service type, which has no daily runtime cap. `dataSync` would be capped by Android.
- **Photo picker / Storage Access Framework** for attachments, so no broad storage permission is needed.

Trade-off: at launch, Android 16 is installed on a minority of active devices, so the potential audience is smaller. This was accepted as decision D1.

---

## 2. Project structure

```
despatch-mobile/
├─ package.json            # capacitor deps, vite (dev server + bundling only, no framework)
├─ capacitor.config.json   # appId: com.despatch.mobile, appName: "Dispatch"
├─ src/
│  ├─ index.html
│  ├─ css/
│  │  ├─ tokens.css        # colour/spacing/type tokens, light + dark, --accent
│  │  ├─ base.css, layout.css, components/*.css
│  ├─ js/
│  │  ├─ main.js           # boot, router
│  │  ├─ router.js         # hash-based, pane-aware router + predictive back
│  │  ├─ layout.js         # width classes, pane state, divider, hinge handling
│  │  ├─ store.js          # tiny observable state store
│  │  ├─ db/               # schema.js, migrations.js, repo-*.js (SQLite access)
│  │  ├─ mail/             # bridge.js (DespatchMail wrapper), sync.js, threading.js, mime.js
│  │  ├─ search/           # query-parser.js, search.js (FTS5), sort.js
│  │  ├─ contacts/         # autocomplete.js
│  │  ├─ calendar/         # date-extract.js, ics.js
│  │  ├─ notify/           # notifications.js
│  │  ├─ theme/            # theme.js (system theme + account accent)
│  │  └─ views/            # account-setup, mailbox, thread, compose, search, settings
│  │     └─ components/    # <dm-message-row>, <dm-address-input>, <dm-avatar> … (Custom Elements)
│  └─ assets/icons/
├─ android/                # generated by `npx cap add android`
│  └─ app/src/main/java/com/despatch/mobile/mail/
│     ├─ DespatchMailPlugin.kt
│     ├─ ImapService.kt, SmtpService.kt
│     ├─ SyncWorker.kt     # WorkManager
│     └─ IdleForegroundService.kt (optional, "push" mode)
└─ tests/                  # vitest (unit) + Playwright (UI in Chromium)
```

UI components are **native Web Components** (Custom Elements with light DOM, styled by shared CSS), which keeps the code vanilla and reusable.

---

## 3. Data model (SQLite)

```sql
accounts(id, email, display_name, imap_host, imap_port, imap_tls, smtp_host, smtp_port,
         smtp_tls, auth_type /*password|oauth*/, accent_color, signature, sync_interval, notify)
folders(id, account_id, path, role /*inbox|sent|drafts|trash|archive|junk*/, uidvalidity,
        uidnext, highestmodseq, unread_count)
messages(id, account_id, folder_id, uid, message_id, in_reply_to, references_hdr,
         thread_id, subject, from_name, from_addr, to_json, cc_json,
         date_sent /*Date header*/, date_received /*INTERNALDATE*/, size /*RFC822.SIZE*/,
         has_attachments, flags, snippet, body_fetched, body_text, body_html)
attachments(id, message_id, part_id, filename, mime, size, local_path)
threads(id, account_id, subject_norm, last_date, message_count, unread_count, has_attachments)
contacts(email PK, name, times_sent_to, times_received_from, last_seen)
messages_fts USING fts5(subject, from_name, from_addr, to_text, body_text, content='messages')
detected_dates(id, message_id, start, end, all_day, title, source_text, dismissed)
```

Indexes on `(folder_id, date_received)`, `(folder_id, date_sent)`, `(folder_id, size)`, `(folder_id, from_addr)` and `(thread_id)` keep sorting fast.

---

## 4. Feature designs

### 4.1 Multiple IMAP accounts
- **Setup wizard:** email + password. Settings are auto-discovered through Mozilla ISPDB (`autoconfig.thunderbird.net`), then `autoconfig.<domain>`, then SRV records, then manual entry.
- **Authentication (v1.0): password or app password only**, sent with IMAP `AUTHENTICATE PLAIN` / `LOGIN` over TLS.
  - The wizard knows which providers require an app password (iCloud, Yahoo, AOL, Fastmail, Gmail with 2-Step Verification, Zoho…). For those it shows a short explanation and a deep link to the provider's app-password page.
  - Login failures are mapped to helpful messages, e.g. "This provider needs an app password", or "IMAP access is disabled in your account settings".
  - Microsoft 365 / Exchange Online accounts have basic authentication disabled. The wizard detects them (from MX/autodiscover) and says that support arrives in v2.0.
  - The native auth layer is written behind an `Authenticator` interface, so XOAUTH2 can be added in v2.0 without restructuring.
- **Unified Inbox** plus per-account folder trees in a navigation drawer.
- **Sync strategy:** CONDSTORE/QRESYNC where the server supports it, UID-range deltas otherwise. Headers and BODYSTRUCTURE are fetched first, and bodies are fetched lazily or prefetched for the latest N messages.
- **Offline outbox:** sends queue in SQLite and retry when back online.

### 4.2 Threaded conversations
- **JWZ threading algorithm** in `threading.js`, using `Message-ID`, `In-Reply-To` and `References`, with a normalised-subject fallback (strip `Re:`, `Fwd:`, `AW:`, `SV:` and similar).
- `X-GM-THRID` is used when the server supports it (Gmail).
- Threads span folders, so your own replies from **Sent** appear inline.
- **Thread view:** collapsible message cards. The latest unread message is expanded; quoted text and signatures are folded.
- A setting lets the user switch threading off.

### 4.3 Email address autocomplete
- The `contacts` table is filled from every header seen and every address sent to.
- **Ranking:** prefix match on name/email, then a score of `times_sent_to*3 + times_received_from + recency decay`.
- `<dm-address-input>` renders chips. It supports keyboard/IME entry, paste of comma-separated lists and address validation, and uses ARIA combobox semantics.
- Optional: import from the Android Contacts provider through the plugin (asks for permission).

### 4.4 Notifications
- **Background:** WorkManager periodic sync (minimum 15 min, user-configurable) in `SyncWorker.kt`. It posts notifications natively, so the WebView doesn't have to be alive.
- **Optional "Push" mode:** a foreground service holding IMAP IDLE on each account's INBOX.
  - It is declared with `foregroundServiceType="remoteMessaging"` and the `FOREGROUND_SERVICE_REMOTE_MESSAGING` permission.
  - It needs a persistent notification (an Android requirement).
  - It reconnects when the network changes, using `ConnectivityManager` callbacks.
- **Channels:** one notification channel per account, so users can tune them in system settings. The account accent colour is used as the notification colour.
- **Grouped notifications** (InboxStyle) show sender and subject. Actions are *Mark read*, *Archive* and *Reply*.
- The `POST_NOTIFICATIONS` runtime permission is requested during onboarding, after an in-app explanation screen. If it is denied, the app keeps working, and Settings shows a banner linking to the system notification settings.

### 4.5 System theme and per-account accent colour
- `tokens.css` defines semantic tokens (`--surface`, `--on-surface`, `--outline`…) for light and dark under `@media (prefers-color-scheme: dark)`.
- `<meta name="color-scheme" content="light dark">` is set.
- The Android side sets the WebView to follow system night mode, and the status and navigation bars are updated to match.
- **Accent:** `--accent` is set on the root for the active account. In the Unified Inbox, each row gets a left stripe / avatar ring in its own account's accent.
- Hover, pressed and container shades are derived with `color-mix(in oklch, var(--accent) …)`.
- Settings include a colour picker with a curated palette plus custom hex.
- **Contrast check:** the accent's on-colour switches between black and white by WCAG contrast.
- **Default accent:** each new account starts with a Material You dynamic colour from the system palette. Later accounts get the next distinct palette tone, so accounts are distinguishable from the start. The user can then override it.
- **Theme changes:** if the system theme or wallpaper palette changes while the app is running, the app picks it up through `matchMedia` change events plus a native configuration-change event.

### 4.6 Search and sorting
- **Local search:** FTS5 over subject, from, to and body. Results show highlighted snippets.
- **Server search:** IMAP `UID SEARCH` runs as a fallback ("Search server") for mail that isn't cached.
- **Query syntax** (`query-parser.js`): `from:`, `to:`, `subject:`, `has:attachment`, `-has:attachment`, `is:unread`, `before:`, `after:`, `larger:5M`. Filter chips build these operators for users who prefer taps.
- **Sort options:** Sender (A–Z / Z–A), Date received (INTERNALDATE), Date sent (Date header), Size.
  - Each sort can go ascending or descending.
  - Sort is saved per folder in `@capacitor/preferences`.
- **Attachment filter:** tri-state All / With attachments / Without. `has_attachments` is derived from BODYSTRUCTURE, ignoring inline images.
- **List rendering:** a virtualised list for large mailboxes, loaded in pages from SQLite in 50-row windows.

### 4.7 Critical-date detection → calendar event (.ics)
- **Extraction (`date-extract.js`)** runs on the plain-text body after the body is fetched.
  - **Dates and times:** a rule-based parser for absolute dates (`12/10/2026`, `12 Oct`, `October 12th 2026`, ISO), weekday/relative dates (`next Friday`, `tomorrow`, `in 3 days`, `end of month`), and times and ranges (`at 3pm`, `14:00–15:30`).
  - **Locale:** day/month order comes from the device locale (`Intl.DateTimeFormat().resolvedOptions()`).
  - **Relative dates** are resolved against the message's **date sent**, not today.
  - **"Critical" scoring:** proximity to keywords such as *deadline, due, by, no later than, submit, expires, renewal, appointment, meeting, RSVP*. Only dates above a threshold are surfaced.
- **UI:** a banner in the message view, e.g. "📅 Due Fri 10 Oct 2026, *submit invoice*". Tapping it opens a prefilled editor with title (subject or keyword phrase), start/end or all-day, a reminder (VALARM, default 1 day before) and notes (sender + snippet).
- **ICS generation (`ics.js`)**, RFC 5545 compliant:
  - `VCALENDAR` / `VEVENT` with `UID`, `DTSTAMP`, `DTSTART` / `DTEND` (TZID or UTC), and `VALARM`
  - Line folding at 75 octets, text escaping, and CRLF line endings
- **Delivery (`.ics` only, per decision D3; the app never writes to the device calendar itself):**
  - **Save:** the file is saved to Downloads through the Storage Access Framework create-document flow, so no storage permission is needed.
  - **Open in Calendar:** an `ACTION_VIEW` intent with MIME type `text/calendar` and a `FileProvider` URI. The user's calendar app shows its own import screen.
  - **Share:** `Share.share()` for sending the event to other apps or people.
  - The app requests no calendar permission.
- The user can dismiss a detection; it is stored in `detected_dates.dismissed`.

### 4.8 Compose and reading (core email features needed around the requested ones)
- **Reading:** reply, reply-all and forward with correct `In-Reply-To` / `References` headers, drafts saved to IMAP Drafts, attachments added via the file picker, signatures per account.
- **HTML rendering:** mail is rendered in a **sandboxed `<iframe srcdoc>`** with a strict CSP and scripts blocked. It is sanitised with DOMPurify (vendored). Remote images are blocked by default ("Load images" per message or per sender), and there is a dark-mode adaptation option.
- **Actions:** swipe for archive/delete (configurable), multi-select, mark read/unread, flag, move.

### 4.9 Tablet and foldable two-pane layout
- **Width classes** follow Material window size classes and are set by CSS media and container queries, not device detection:

  | Width class | Window width | Layout |
  |---|---|---|
  | Compact | under 600dp | One pane. The list and the thread view are separate routes. |
  | Medium | 600–839dp | Two panes: message list (about 360dp) and reading pane. The folder drawer is a modal overlay. |
  | Expanded | 840dp and wider | Three regions: a permanent navigation rail or drawer, the message list, and the reading pane. |
  | Large (1200dp+) | | Same as Expanded, with a wider list that shows extra columns (size, attachment icon, date sent). |

- **One DOM tree for every size.** A `layout.js` controller watches `matchMedia` and toggles pane state. The router keeps `#/folder/:id` and `#/thread/:id` in the URL at every width, so rotating the screen or unfolding a foldable keeps the current selection.
- **Back navigation per layout.**
  - One pane: back goes from thread to list.
  - Two panes: back clears the selection, then leaves the folder.
  - Predictive back animates whichever pane is closing.
- **Resizable divider** between list and reading pane. Its position is saved to preferences.
- **Foldables:** the device hinge is read through the native `WindowInfoTracker` (Jetpack WindowManager). When the device is half-open in book posture, the split is aligned to the hinge.
- **Compose:**
  - Medium and wider: compose opens as a large dialog, or in the reading pane for replies.
  - Compact: compose is full screen.
- **Hardware keyboard and mouse** (tablets with keyboards, desktop mode):
  - Shortcuts: `j` / `k` move between messages, `r` reply, `a` reply all, `f` forward, `e` archive, `#` delete, `/` search, `c` compose.
  - Right-click context menus, hover states, and visible focus rings.
- **Multi-window and split-screen:** fully resizable, and the layout reflows live as the window size changes.

---

## 5. Security and privacy
- Credentials and OAuth refresh tokens are stored only in the Android Keystore, never in SQLite or `localStorage`.
- The SQLite database is encrypted with SQLCipher. The key is held in the Keystore.
- TLS is required by default. STARTTLS is allowed; plaintext only after an explicit warning.
- A strict app CSP is set, and message HTML is kept isolated in a sandboxed iframe.
- Remote content is blocked by default, which also blocks tracking pixels.
- No analytics. `android:allowBackup` is limited to settings only.

---

## 6. Milestones

| # | Milestone | Deliverables | Est. |
|---|---|---|---|
| 0 | **Scaffold** | Vite + Capacitor project (minSdk/targetSdk 36), Android platform, edge-to-edge insets, predictive back, CSS tokens, router, Web Component base, lint/test setup, CI build of debug APK | 3 d |
| 1 | **Native mail plugin** | `DespatchMail` Kotlin plugin: connect/list folders/fetch envelopes/fetch body/flags/move/SMTP send; JS bridge wrapper; secure credential storage | 8 d |
| 2 | **Accounts and sync** | Setup wizard with autodiscovery and app-password guidance, SQLite schema/migrations, incremental sync, multi-account drawer, Unified Inbox | 6 d |
| 3 | **Mailbox and reading** | Virtualised message list, sandboxed HTML viewer, attachments, actions/swipes | 6 d |
| 4 | **Threading** | JWZ implementation + tests, thread list and thread view, cross-folder threads | 4 d |
| 5 | **Compose** | Compose view, reply/forward headers, drafts, outbox queue, **address autocomplete** | 5 d |
| 6 | **Search and sort** | FTS5 index, query parser, filter chips, all sort modes, attachment filter, server search fallback | 5 d |
| 7 | **Theme and accents** | System light/dark, Material You default accents, per-account accent picker, contrast logic, system bar sync | 2 d |
| 8 | **Notifications** | WorkManager sync worker, per-account channels, grouped notifications with actions, optional IDLE `remoteMessaging` foreground service | 5 d |
| 9 | **Date detection and ICS** | Extractor + test corpus, banner UI, event editor, RFC 5545 generator, save/open/share | 5 d |
| 10 | **Adaptive layout** | Width-class layouts, two- and three-pane layouts, resizable divider, foldable hinge support, keyboard shortcuts, multi-window | 5 d |
| 11 | **Hardening and release** | Accessibility pass (TalkBack, font scaling), performance on 50k-message folders, error/offline states, Play Store assets (phone + tablet screenshots), signed AAB | 5 d |

**Total:** roughly 59 developer-days, about 12 weeks for one developer. The OAuth milestone (−4 d) moved to v2.0, and the adaptive layout milestone (+5 d) was added.

Building milestones 3–5 with the pane structure in mind (a single DOM tree with a pane-aware router) keeps milestone 10 mostly layout and CSS work rather than a rewrite.

---

### Status (27 September 2026)

| # | Milestone | Status |
|---|---|---|
| 0–4 | Scaffold, mail plugin, accounts and sync, reading, threading | Done; used on a Pixel 10a |
| 5 | Compose | Done; not yet tried on a device |
| 6 | Search and sort | Done, using FTS4 rather than FTS5 (the browser build's sql.js only has FTS4); not yet tried on a device |
| 7 | Theme and accents | Done; not yet tried on a device |
| 8 | Notifications | Done; not yet tried on a device (background timing, IDLE and notification actions need real-device testing) |
| 9 | Date detection and ICS | Done; not yet tried on a device |
| 10 | Adaptive layout | Done; fold alignment tested with simulated hinge events only |
| 11 | Hardening and release | Done except: a release signing key (to be created by the owner), R8 minification (left off until tested on a device), and TalkBack testing on a device |

---

## 7. Testing strategy
- **Unit tests (Vitest):**
  - threading (JWZ edge cases: missing parents, subject-only threads)
  - query parser and sort comparators
  - date extraction (a corpus of about 200 real-world phrasings, multiple locales)
  - ICS output (checked against an RFC 5545 validator)
  - autocomplete ranking
- **Integration tests:** a local **GreenMail** or **Dovecot** Docker IMAP/SMTP server for plugin and sync tests. Instrumented tests for the Kotlin plugin.
- **UI tests:** Playwright against the web build, with a mocked `DespatchMail` bridge, in light and dark mode.
- **Layout tests:** Playwright at each width-class breakpoint (360, 600, 840 and 1280 px), plus resize and rotation tests to check that the selection is kept.
- **Device matrix (Android 16+ only):**
  - Emulators: Pixel phone, Pixel Tablet, and Pixel Fold (both folded and unfolded postures).
  - At least one physical Android 16 phone and one physical tablet.
  - Test runs in light and dark theme, at 200% font scale, and in split-screen.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Gmail/Outlook restrict password IMAP; Microsoft 365 blocks it entirely | v1: app-password guidance, with a clear "coming in v2.0" message for Microsoft 365. v2.0: OAuth2. Start Google's restricted-scope verification during v1 development, because it takes weeks. |
| Android 16 minimum limits the audience at launch | Accepted (D1). Adoption grows over the v1 lifetime. The minimum could be revisited later, but that would mean adding compatibility work. |
| Android background limits (Doze, app standby buckets, OEM battery killers) delay notifications | Offer the IDLE `remoteMessaging` "Push" mode and battery-optimisation guidance |
| Two-pane layout added late causes rework | Pane-aware router and single DOM tree from milestone 0; layout tests at each breakpoint |
| HTML email rendering security | Sandboxed iframe, DOMPurify, CSP, no JS, remote content off |
| Large mailboxes slow in WebView | SQLite paging, virtualised list, lazy body fetch, FTS5 |
| False positives in date detection | Keyword-proximity scoring, user always confirms before creating an event, dismiss option |

---

## 9. Open questions

The four earlier questions are resolved; see the Decisions log (§0). No open questions remain.

---

## 10. v2.0 roadmap (out of scope for v1.0)
- **Gmail OAuth2 (XOAUTH2)**, including Google restricted-scope verification and a CASA security assessment. Optionally Gmail labels (`X-GM-LABELS`).
- **Outlook.com / Microsoft 365 / Exchange Online OAuth2** for IMAP and SMTP, through the Microsoft identity platform.
- **On-premises Exchange** (EWS or ActiveSync) is to be evaluated separately. It is a different protocol stack from IMAP.
- **Token storage and refresh** in the Keystore, plugged into the `Authenticator` interface prepared in v1.
