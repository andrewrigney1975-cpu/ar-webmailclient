/**
 * iCalendar (.ics) files, RFC 5545 (PLAN.md §4.7). Timed events are written
 * in UTC, so no VTIMEZONE is needed; all-day events use DATE values with an
 * exclusive end date. Lines are CRLF-terminated and folded at 75 octets.
 */

export const REMINDERS = [
  { minutes: null, label: 'No reminder' },
  { minutes: 0, label: 'At the time' },
  { minutes: 30, label: '30 minutes before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 24 * 60, label: '1 day before' },
  { minutes: 7 * 24 * 60, label: '1 week before' },
];

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

export function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Local calendar date (the day the user picked), not converted to UTC. */
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** TEXT value escaping (RFC 5545 §3.3.11). */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Folds a content line at 75 octets without splitting a UTF-8 character. */
export function foldLine(line) {
  const encoder = new TextEncoder();
  const out = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** VALARM trigger relative to the start. All-day "at the time" reminders fire at 9:00 on the day. */
function alarmTrigger(minutes, allDay) {
  if (minutes === 0) return allDay ? 'PT9H' : 'PT0M';
  if (minutes % (24 * 60) === 0) return `-P${minutes / (24 * 60)}D`;
  if (minutes % 60 === 0) return `-PT${minutes / 60}H`;
  return `-PT${minutes}M`;
}

/**
 * @param {object} event  { uid, title, start, end, allDay, description, location, reminderMinutes }
 */
export function buildIcs(event, { now = Date.now(), productId = '-//Despatch Mobile//EN' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${productId}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT'];
  lines.push(`UID:${event.uid}`);
  lines.push(`DTSTAMP:${utcStamp(now)}`);
  if (event.allDay) {
    const end = event.end > event.start ? event.end : event.start + 86_400_000;
    lines.push(`DTSTART;VALUE=DATE:${localDate(event.start)}`);
    lines.push(`DTEND;VALUE=DATE:${localDate(end)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(event.start)}`);
    lines.push(`DTEND:${utcStamp(event.end > event.start ? event.end : event.start + 3_600_000)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.title || 'Event')}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.reminderMinutes != null) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(event.title || 'Reminder')}`);
    lines.push(`TRIGGER:${alarmTrigger(event.reminderMinutes, event.allDay)}`);
    lines.push('END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** A filename for the event, e.g. "Invoice due 2026-10-16.ics". */
export function icsFilename(event) {
  const d = new Date(event.start);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const title = (event.title || 'Event').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 50) || 'Event';
  return `${title} ${date}.ics`;
}
