import { describe, expect, it } from 'vitest';
import { dayFirst, detectDates } from '../src/js/calendar/date-extract.js';
import { buildIcs, escapeText, foldLine, icsFilename, localDate, utcStamp } from '../src/js/calendar/ics.js';

// Tuesday 13 October 2026, 10:00 local time.
const SENT = new Date(2026, 9, 13, 10).getTime();
const at = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

function detect(text, options = {}) {
  return detectDates(text, { sentAt: SENT, now: SENT, locale: 'en-AU', ...options });
}

function first(text, options) {
  const [result] = detect(text, options);
  return result && { start: result.start, end: result.end, allDay: result.allDay };
}

describe('detectDates', () => {
  it.each([
    ['Please submit the report by Friday.', at(10, 16), true],
    ['The invoice is due on 23 October.', at(10, 23), true],
    ['Payment due 2026-11-01', at(11, 1), true],
    ['Deadline: 15/10/2026', at(10, 15), true],
    ['RSVP by Oct 20th please', at(10, 20), true],
    ['The offer expires in two weeks.', at(10, 27), true],
    ['Renewal is due at the end of the month.', at(10, 31), true],
    ['Due by COB today', at(10, 13), true],
    ['Please pay the deposit by 5/11', at(11, 5), true],
    ['Submit it by Fri 16 Oct.', at(10, 16), true],
  ])('%s', (text, day, allDay) => {
    expect(first(text)).toMatchObject({ start: day, allDay });
  });

  it('reads times and ranges', () => {
    expect(first('Meeting tomorrow at 3pm')).toEqual({ start: at(10, 14, 15), end: at(10, 14, 16), allDay: false });
    expect(first('Interview on Monday 2-4pm')).toEqual({ start: at(10, 19, 14), end: at(10, 19, 16), allDay: false });
    expect(first('Your appointment is on Thursday, 22 October at 14:15.')).toMatchObject({ start: at(10, 22, 14, 15) });
    expect(first('The meeting runs 09:30 to 11:00 on 21 October')).toMatchObject({ start: at(10, 21, 9, 30), end: at(10, 21, 11) });
    expect(first('Call at noon tomorrow')).toMatchObject({ start: at(10, 14, 12) });
    expect(first('Webinar starts 3.30pm on 20 Oct')).toMatchObject({ start: at(10, 20, 15, 30) });
  });

  it('treats "next Friday" as the Friday of next week, and bare weekdays as the coming one', () => {
    expect(first('Can we meet next Friday at 10:30am?')).toMatchObject({ start: at(10, 23, 10, 30) });
    expect(first('Can we meet on Friday?')).toMatchObject({ start: at(10, 16) });
    // Sent on a Friday, "by Friday" means next week's.
    expect(first('Send it by Friday', { sentAt: at(10, 16, 9), now: at(10, 16, 9) })).toMatchObject({ start: at(10, 23) });
  });

  it('uses the locale’s day/month order for numeric dates', () => {
    expect(dayFirst('en-AU')).toBe(true);
    expect(dayFirst('en-US')).toBe(false);
    expect(first('Deadline 10/15/2026', { locale: 'en-US' })).toMatchObject({ start: at(10, 15) });
    expect(detect('Deadline 10/15/2026')).toEqual([]); // month 15 isn't valid day-first
  });

  it('resolves relative dates from when the message was sent', () => {
    const sentEarlier = at(10, 1, 9);
    expect(first('Due tomorrow', { sentAt: sentEarlier, now: at(10, 1, 12) })).toMatchObject({ start: at(10, 2) });
    // Dates without a year roll over to the next year once passed.
    expect(first('Renewal due 5 January', { locale: 'en-AU' })).toMatchObject({ start: new Date(2027, 0, 5).getTime() });
  });

  it('ignores dates without deadline or appointment words, past dates, quotes and decimals', () => {
    expect(detect('We had a great time on 20 October.')).toEqual([]);
    expect(detect('The deadline was 1 October.')).toEqual([]);
    expect(detect('> Due Friday\n> Meeting tomorrow at 3pm')).toEqual([]);
    expect(detect('Version 3.5 is due soon')).toEqual([]);
    expect(detect('Call me on 0400 123 456 before 5')).toEqual([]);
  });

  it('keeps one suggestion per day, preferring one with a time, and titles it from the sentence', () => {
    const results = detect('Hi Andrew, the report is due Friday. Our review meeting is Friday at 2pm.');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ start: at(10, 16, 14), allDay: false });
    expect(detect('Hi Andrew, the report is due Friday.')[0].title).toBe('the report is due Friday');
  });

  it('finds several different dates in order', () => {
    const results = detect('Draft due 20 October. Final version due 3 November. Launch meeting 10 November at 9am.');
    expect(results.map((r) => new Date(r.start).getDate())).toEqual([20, 3, 10]);
  });
});

describe('ics', () => {
  const event = {
    uid: 'abc@despatch',
    title: 'Pay invoice #1042, today; really',
    start: at(10, 16, 15),
    end: at(10, 16, 16),
    allDay: false,
    description: 'From Bob\nPlease pay',
    reminderMinutes: 24 * 60,
  };

  it('writes a valid VEVENT with UTC times, escaping and an alarm', () => {
    const ics = buildIcs(event, { now: Date.UTC(2026, 9, 13, 0, 0, 0) });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.split('\r\n').slice(0, 6)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Dispatch Mobile//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
    ]);
    expect(ics).toContain(`DTSTART:${utcStamp(event.start)}\r\n`);
    expect(ics).toContain('DTSTAMP:20261013T000000Z\r\n');
    expect(ics).toContain('SUMMARY:Pay invoice #1042\\, today\\; really\r\n');
    expect(ics).toContain('DESCRIPTION:From Bob\\nPlease pay\r\n');
    expect(ics).toContain('BEGIN:VALARM\r\nACTION:DISPLAY\r\n');
    expect(ics).toContain('TRIGGER:-P1D\r\n');
    expect(ics.match(/^BEGIN:/gm)).toHaveLength(ics.match(/^END:/gm).length);
  });

  it('writes all-day events as dates with an exclusive end', () => {
    const ics = buildIcs({ uid: 'x', title: 'Due', start: at(10, 16), end: at(10, 17), allDay: true, reminderMinutes: 0 });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261016\r\n');
    expect(ics).toContain('DTEND;VALUE=DATE:20261017\r\n');
    expect(ics).toContain('TRIGGER:PT9H\r\n');
    expect(localDate(at(10, 16))).toBe('20261016');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const long = `DESCRIPTION:${'Café ☕ '.repeat(30)}`;
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((line) => line.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('escapes text and names files', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    expect(icsFilename(event)).toBe('Pay invoice 1042 today really 2026-10-16.ics');
  });
});

describe('suggestions and the event editor', () => {
  it('drops dismissed days and builds a prefilled event', async () => {
    const { syncFixture } = await import('./helpers.js');
    const { suggestionsFor, dismissSuggestion, eventFromSuggestion } = await import('../src/js/calendar/calendar.js');
    const { syncFolderList, syncFolder } = await import('../src/js/mail/sync.js');
    const { listFolders } = await import('../src/js/db/repo-folders.js');
    const { listMessages } = await import('../src/js/db/repo-messages.js');
    const fx = await syncFixture();
    await syncFolderList(fx);
    const inbox = (await listFolders(fx.db)).find((f) => f.role === 'inbox');
    await syncFolder({ ...fx, folder: inbox });
    const [message] = await listMessages(fx.db, { folderId: inbox.id });
    const msg = { ...message, dateSent: SENT, subject: 'Report' };

    const text = 'The report is due Friday. The review meeting is 23 October at 2pm.';
    const found = await suggestionsFor(fx.db, msg, text, { now: SENT, locale: 'en-AU' });
    expect(found.map((s) => new Date(s.start).getDate())).toEqual([16, 23]);

    await dismissSuggestion(fx.db, message.id, found[0].start);
    const after = await suggestionsFor(fx.db, msg, text, { now: SENT, locale: 'en-AU' });
    expect(after.map((s) => new Date(s.start).getDate())).toEqual([23]);

    const event = eventFromSuggestion(after[0], msg);
    expect(event).toMatchObject({ allDay: false, reminderMinutes: 60, title: 'The review meeting is 23 October at 2pm' });
    expect(event.description).toContain('“Report”');
    expect(event.uid).toMatch(/@despatch-mobile$/);
  });

  it('reads the editor form into an event', async () => {
    const { readEventForm } = await import('../src/js/views/components/event-editor.js');
    const form = (values) => ({
      allDay: { checked: values.allDay },
      date: { value: values.date },
      startTime: { value: values.start ?? '' },
      endTime: { value: values.end ?? '' },
      reminder: { value: values.reminder ?? '' },
      title: { value: values.title ?? '' },
      notes: { value: '' },
    });
    expect(readEventForm(form({ allDay: false, date: '2026-10-16', start: '15:00', end: '14:00', reminder: '30' }), {})).toMatchObject({
      start: at(10, 16, 15),
      end: at(10, 16, 16), // an end before the start becomes one hour
      reminderMinutes: 30,
      title: 'Event',
    });
    expect(readEventForm(form({ allDay: true, date: '2026-10-16' }), {})).toMatchObject({
      start: at(10, 16),
      end: at(10, 17),
      reminderMinutes: null,
    });
  });
});
