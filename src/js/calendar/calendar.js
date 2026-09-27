/**
 * Calendar suggestions for a message (PLAN.md §4.7): detection with the
 * user's dismissals applied, and exporting an event as an .ics file to open
 * in the calendar app, save to Downloads, or share. The app never writes to
 * the device calendar itself (decision D3).
 */
import { Capacitor } from '@capacitor/core';
import { detectDates } from './date-extract.js';
import { buildIcs, icsFilename } from './ics.js';

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export async function suggestionsFor(db, message, text, { now = Date.now(), locale } = {}) {
  const dismissed = new Set(
    (await db.all('SELECT day FROM dismissed_dates WHERE message_id = ?', [message.id])).map((r) => r.day),
  );
  return detectDates(text, { sentAt: message.dateSent ?? message.dateReceived, now, locale, subject: message.subject }).filter(
    (s) => !dismissed.has(startOfDay(s.start)),
  );
}

export async function dismissSuggestion(db, messageId, start) {
  await db.run('INSERT OR IGNORE INTO dismissed_dates (message_id, day) VALUES (?, ?)', [messageId, startOfDay(start)]);
}

/** An event prefilled from a suggestion, with a one-day reminder. */
export function eventFromSuggestion(suggestion, message) {
  const sender = message.from ? message.from.name || message.from.address : 'unknown sender';
  return {
    uid: `${crypto.randomUUID()}@despatch-mobile`,
    title: suggestion.title,
    start: suggestion.start,
    end: suggestion.end,
    allDay: suggestion.allDay,
    reminderMinutes: suggestion.allDay ? 24 * 60 : 60,
    description: `From ${sender}: “${message.subject ?? ''}”\n\n${suggestion.sourceText}`,
  };
}

/** Writes the .ics to the cache and opens, saves or shares it. `action`: 'open' | 'save' | 'share'. */
export async function exportEvent(event, action, { mail }) {
  const ics = buildIcs(event);
  const filename = icsFilename(event);

  if (!Capacitor.isNativePlatform()) {
    // Browser development: download it.
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'downloaded';
  }

  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const { uri } = await Filesystem.writeFile({
    path: `calendar/${crypto.randomUUID()}/${filename}`,
    data: ics,
    encoding: Encoding.UTF8,
    directory: Directory.Cache,
    recursive: true,
  });
  const path = decodeURIComponent(new URL(uri).pathname);
  if (action === 'save') await mail.saveToDownloads(path, filename, 'text/calendar');
  else if (action === 'share') await mail.shareFile(path, 'text/calendar', filename);
  else await mail.openFile(path, 'text/calendar');
  return action;
}
