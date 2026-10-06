# Dispatch Mobile: privacy policy

_Last updated: 27 September 2026_

Dispatch Mobile is an email app. It connects to the email accounts you add and to nothing else run by us: there is no Dispatch server, no analytics, no advertising and no account to create with us.

## What the app stores, and where

Everything stays on your device.

- **Your mail:** message headers, the bodies you open, and attachments you download. Stored in an encrypted database (SQLCipher) in the app's private storage. Messages fetched in the background for a notification are kept encrypted (with a key held in the Android Keystore) in the app's private storage until the app next opens and moves them into its database.
- **Blocked senders:** the addresses and domains you block, in the same encrypted database and in the app's private settings for background checks.
- **Your account settings:** server names, usernames, your display name, signature and colour choices.
- **Your passwords:** encrypted with a key held in the Android Keystore. They never leave the device except when sent to your own mail server to sign in.
- **Contacts:** names and addresses seen in your mail, used only to suggest recipients as you type.
- **Preferences:** app settings such as sort order and notification choices.

Android's backup and device-to-device transfer include only your app preferences. Mail, the database, passwords and account data are excluded.

## Who the app talks to

- **Your mail servers (IMAP and SMTP),** to read, sync and send your mail. These connections use TLS unless you explicitly choose an unencrypted server after a warning.
- **When you add an account, to find its settings:**
  - your email domain's own autoconfiguration address;
  - Mozilla's public mail-provider database (`autoconfig.thunderbird.net`), which receives only the domain part of your address;
  - Cloudflare's public DNS (`cloudflare-dns.com`), to look up your domain's mail servers.
- **Senders' servers for images in emails, only if you tap "Show images"** or allow them for a sender. By default remote images are blocked, so senders can't tell when you open their mail.
- **A certificate authority, when needed.** If a mail server doesn't send its full certificate chain, the app downloads the missing certificate from the address named in the server's certificate, so it can verify the connection.

## Notifications

To tell you about new mail while the app is closed, it checks your Inbox in the background using the password stored on the device. No notification content goes through any third-party service.

## Removing your data

Removing an account in Settings deletes its mail, settings and password from the device. Uninstalling the app deletes everything. Nothing is deleted from your mail server.

## Children

Dispatch Mobile is a general-purpose email app and isn't directed at children.

## Changes and contact

If this policy changes, the new version will be published with the app. Questions: (your support address).
