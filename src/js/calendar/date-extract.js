/**
 * Finds dates in an email that look like something to do (PLAN.md §4.7):
 * deadlines, due dates, appointments, meetings.
 *
 * Understands:
 *   - "15 October 2026", "15th Oct", "October 15", "Fri 16 Oct", ISO "2026-10-15"
 *   - numeric "15/10/2026" and "15/10", in the locale's day/month order
 *   - "today", "tomorrow", "Friday", "next Friday", "in 3 days", "in two weeks",
 *     "end of the week/month", "EOD", "close of business"
 *   - times "3pm", "3:30 pm", "15:00", "noon", and ranges "2–4pm", "14:00 to 15:30"
 *
 * Relative dates are resolved from when the message was sent, not today.
 * A date is kept when its sentence has deadline or appointment words near it
 * ("due", "by", "deadline", "meeting", "RSVP" …) and it isn't already past.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)';
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// Words that make a date worth offering, by weight.
const KEYWORDS = [
  [/\b(deadline|due|overdue|no later than|expir(?:es|y|ing|ation)|cut-?off|rsvp|submit|lodge|renew(?:al)?)\b/i, 3],
  [/\b(by|before|until|appointment|meet|meeting|interview|reminder|closes?|payment|pay|starts?|begins?|scheduled|booked|call|webinar|session|event)\b/i, 2],
];
const THRESHOLD = 2;
const DAY = 86_400_000;

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function monthIndex(name) {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

function weekdayIndex(name) {
  return WEEKDAYS.findIndex((w) => w.startsWith(name.slice(0, 3).toLowerCase()));
}

/** True when the locale writes day before month (15/10 rather than 10/15). */
export function dayFirst(locale) {
  const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2020, 11, 31));
  return parts.findIndex((p) => p.type === 'day') < parts.findIndex((p) => p.type === 'month');
}

function validDate(year, month, day) {
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date.getTime() : null;
}

const RECENT_PAST_MS = 60 * DAY;

/**
 * Without a year: the next such day on or after the day it was sent, except
 * that a day in the last two months stays in the past ("was due 1 October").
 */
function nextOccurrence(month, day, sentDay) {
  const year = new Date(sentDay).getFullYear();
  const thisYear = validDate(year, month, day);
  if (thisYear !== null && (thisYear >= sentDay || sentDay - thisYear <= RECENT_PAST_MS)) return thisYear;
  return validDate(year + 1, month, day);
}

function fullYear(text) {
  const n = Number(text);
  return text.length <= 2 ? 2000 + n : n;
}

/** Date mentions: [{ index, length, day (ms, local midnight) }]. */
function findDates(sentence, { sentDay, locale }) {
  const found = [];
  const add = (match, day) => {
    if (day !== null && day !== undefined) found.push({ index: match.index, length: match[0].length, day });
  };

  const patterns = [
    // 15 October 2026 / Fri 15th of Oct
    [new RegExp(`\\b(?:${WEEKDAY}\\.?,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
      (m) => (m[4] ? validDate(Number(m[4]), monthIndex(m[3]), Number(m[2])) : nextOccurrence(monthIndex(m[3]), Number(m[2]), sentDay))],
    // October 15 2026 / Fri, Oct 15th
    [new RegExp(`\\b(?:${WEEKDAY}\\.?,?\\s+)?${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
      (m) => (m[4] ? validDate(Number(m[4]), monthIndex(m[2]), Number(m[3])) : nextOccurrence(monthIndex(m[2]), Number(m[3]), sentDay))],
    // 2026-10-15
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]))],
    // 15/10/2026, 15.10.26, 15-10-2026
    [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/g, (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const [day, month] = dayFirst(locale) ? [a, b] : [b, a];
      return validDate(fullYear(m[3]), month - 1, day);
    }],
    // 15/10 (no year; slash only, so decimals and times aren't dates)
    [/\b(\d{1,2})\/(\d{1,2})\b(?![/.\d])/g, (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const [day, month] = dayFirst(locale) ? [a, b] : [b, a];
      return month >= 1 && month <= 12 ? nextOccurrence(month - 1, day, sentDay) : null;
    }],
    [/\b(today|tonight|this (?:morning|afternoon|evening)|eod|end of (?:the )?day|close of business|cob)\b/gi, () => sentDay],
    [/\b(?:the )?day after tomorrow\b/gi, () => sentDay + 2 * DAY],
    [/\btomorrow\b/gi, () => sentDay + DAY],
    [/\bin (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (day|week|fortnight)s?\b/gi, (m) => {
      const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      return sentDay + n * { day: 1, week: 7, fortnight: 14 }[m[2].toLowerCase()] * DAY;
    }],
    [/\bend of (?:the |this )?week\b/gi, () => {
      const weekday = new Date(sentDay).getDay();
      return sentDay + ((5 - weekday + 7) % 7) * DAY; // Friday
    }],
    [/\bend of (?:the |this )?month\b/gi, () => {
      const d = new Date(sentDay);
      return new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
    }],
    // (next|this|on|by)? Friday; "next Friday" means the Friday of next week.
    [new RegExp(`\\b(next|this|on|by|before|until|coming)?\\s*${WEEKDAY}\\b`, 'gi'), (m) => {
      const target = weekdayIndex(m[2]);
      const today = new Date(sentDay).getDay();
      if (m[1]?.toLowerCase() === 'next') {
        const mondayOffset = (today + 6) % 7; // days since Monday
        const nextMonday = sentDay + (7 - mondayOffset) * DAY;
        return nextMonday + ((target + 6) % 7) * DAY;
      }
      const ahead = (target - today + 7) % 7 || 7;
      return sentDay + ahead * DAY;
    }],
  ];

  for (const [pattern, resolve] of patterns) {
    for (const match of sentence.matchAll(pattern)) {
      // Skip text overlapping a longer date already found (e.g. "on Thursday" in "on Thursday, 22 October").
      const end = match.index + match[0].length;
      const overlaps = found.some((f) => match.index < f.index + f.length && end > f.index);
      if (!overlaps) add(match, resolve(match));
    }
  }
  return found;
}

function to24(hour, minutes, meridiem) {
  let h = hour % 12;
  if (meridiem && /^p/i.test(meridiem)) h += 12;
  if (!meridiem) h = hour;
  return h * 60 + (minutes ?? 0);
}

/** Times in a sentence: [{ index, start (minutes after midnight), end|null }]. */
function findTimes(sentence) {
  const times = [];
  const range = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/gi;
  for (const m of sentence.matchAll(range)) {
    const endMeridiem = m[6];
    const start = to24(Number(m[1]), m[2] && Number(m[2]), m[3] ?? endMeridiem);
    times.push({ index: m.index, length: m[0].length, start, end: to24(Number(m[4]), m[5] && Number(m[5]), endMeridiem) });
  }
  const range24 = /\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|to|until)\s*([01]?\d|2[0-3]):([0-5]\d)\b/g;
  for (const m of sentence.matchAll(range24)) {
    times.push({ index: m.index, length: m[0].length, start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) });
  }
  const single = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)\b|\b(noon|midday|midnight)\b/gi;
  for (const m of sentence.matchAll(single)) {
    if (times.some((t) => m.index >= t.index && m.index < t.index + t.length)) continue;
    let start;
    if (m[6]) start = /midnight/i.test(m[6]) ? 0 : 12 * 60;
    else if (m[3]) start = to24(Number(m[1]), m[2] && Number(m[2]), m[3]);
    else start = Number(m[4]) * 60 + Number(m[5]);
    if (m[3] && Number(m[1]) > 12) continue;
    times.push({ index: m.index, length: m[0].length, start, end: null });
  }
  return times;
}

function scoreSentence(sentence) {
  return KEYWORDS.reduce((score, [pattern, weight]) => (pattern.test(sentence) ? Math.max(score, weight) : score), 0);
}

function titleFrom(sentence, subject) {
  const clean = sentence.replace(/\s+/g, ' ').replace(/^(hi|hello|dear|hey)\b[^,]*,\s*/i, '').trim();
  if (clean.length <= 80) return clean.replace(/[.!]+$/, '');
  return subject?.trim() || `${clean.slice(0, 77)}…`;
}

/**
 * @param {string} text  plain-text body
 * @param {object} options  { sentAt, now, locale, subject }
 * @returns {{ start: number, end: number, allDay: boolean, title: string, sourceText: string, score: number }[]}
 */
export function detectDates(text, { sentAt, now = Date.now(), locale = undefined, subject = '' } = {}) {
  const sentDay = startOfDay(sentAt ?? now);
  const today = startOfDay(now);
  // Quoted history is someone else's earlier message; only look at what was written.
  const written = (text ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join('\n');
  const sentences = written.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

  const results = [];
  for (const sentence of sentences) {
    const score = scoreSentence(sentence);
    if (score < THRESHOLD) continue;
    const times = findTimes(sentence);
    for (const date of findDates(sentence, { sentDay, locale })) {
      if (date.day < today) continue;
      // The closest time in the same sentence belongs to this date.
      const time = times.sort((a, b) => Math.abs(a.index - date.index) - Math.abs(b.index - date.index))[0];
      const start = time ? date.day + time.start * 60_000 : date.day;
      const end = time ? date.day + (time.end ?? time.start + 60) * 60_000 : date.day + DAY;
      results.push({ start, end, allDay: !time, title: titleFrom(sentence, subject), sourceText: sentence, score });
    }
  }

  // One suggestion per day: one with a time wins (it's more specific), then the strongest.
  const byDay = new Map();
  const better = (a, b) => (a.allDay !== b.allDay ? !a.allDay : a.score > b.score);
  for (const result of results) {
    const key = startOfDay(result.start);
    const current = byDay.get(key);
    if (!current || better(result, current)) byDay.set(key, result);
  }
  return [...byDay.values()].sort((a, b) => a.start - b.start);
}
