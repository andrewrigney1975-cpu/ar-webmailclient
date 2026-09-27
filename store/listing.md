# Google Play listing: Dispatch Mobile

## App details

- **App name:** Dispatch Mobile
- **Category:** Communication
- **Tags:** Email, Productivity
- **Contact email:** (your support address)
- **Privacy policy URL:** host `docs/privacy-policy.md` (e.g. GitHub Pages) and link it here.

## Short description (80 characters max)

All your IMAP email in one place: conversations, fast search and deadlines.

## Full description

Dispatch Mobile is a clean, fast email app for any IMAP account: your own domain, your hosting provider's mailbox, Fastmail, iCloud, Yahoo, Gmail with an app password, and more. Add as many accounts as you like and read them together in the Unified Inbox, each with its own colour.

**Conversations.** Replies are grouped with the messages they answer, including the ones you sent, and quoted history is tucked away so you see what's new.

**Search that finds it.** Search every account on the device in an instant, with filters like from:, has:attachment, is:unread or before:, and search the server for older mail.

**Deadlines to your calendar.** When an email mentions a due date, a meeting or an appointment, Dispatch Mobile offers to add it to your calendar as an event file, with a reminder.

**Private by design.**
- Your mail is stored on your phone in an encrypted database, and your passwords stay in Android's secure key store.
- Remote images in emails are blocked until you allow them, so senders can't track when you open their mail.
- Email content is shown in a locked-down view where scripts can't run.
- No ads, no analytics, no accounts with us: the app talks only to your mail servers.

**Made for Android.**
- Follows your light or dark theme and Material You colours.
- Swipe to archive or delete, with Undo.
- New-mail notifications with Mark read, Archive and Reply.
- Optional instant notifications.
- Two panes on tablets and foldables.
- Keyboard shortcuts when you use a keyboard.

Requires Android 16 or later. Outlook.com and Microsoft 365 accounts are not supported yet; support is planned for version 2.0.

## Graphics

| Asset | File | Size |
|---|---|---|
| App icon | `store/icon-512.png` | 512 × 512 |
| Feature graphic | `store/feature-graphic.png` | 1024 × 500 |
| Phone screenshots | `store/screenshots/phone-*.png` | 1082 × 2402 |
| Tablet screenshot | `store/screenshots/tablet-1-conversation.png` | 2560 × 1600 |

Regenerate them with `npm run dev -- --port 5195` and `node scripts/screenshots.mjs` (demo mode, sample mail).

## Data safety answers

- **Data collected:** none. Nothing is sent to the developer.
- **Data shared:** none.
- **Data handled on the device:** email addresses, message content, contacts seen in mail, and account credentials. These are stored only on the device, encrypted, and sent only to the user's own mail servers over TLS.
- **Account deletion:** there are no developer-side accounts. Removing an account in the app deletes its data from the device.
- **Encryption in transit:** yes (TLS for IMAP and SMTP). Unencrypted connections are only possible after an explicit warning.

## Content rating

Communication app with user-to-user messaging through the user's own email accounts. No user-generated content is hosted by the app.
