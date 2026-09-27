/** Display formatting for dates, sizes and people, using the device locale. */

const DAY = 86_400_000;

/**
 * Message list dates: time for today, weekday within the last week, day and
 * month this year, full date otherwise.
 */
export function formatListDate(timestamp, now = Date.now(), locale = undefined) {
  if (timestamp == null) return '';
  const date = new Date(timestamp);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  if (timestamp >= startOfToday) {
    return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  }
  if (timestamp >= startOfToday - 6 * DAY) {
    return date.toLocaleDateString(locale, { weekday: 'short' });
  }
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatFullDate(timestamp, locale = undefined) {
  if (timestamp == null) return '';
  return new Date(timestamp).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function displayName(person) {
  if (!person) return '(unknown sender)';
  return person.name?.trim() || person.address;
}

export function formatAddressList(people) {
  return people.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ');
}

/** Plain text from an HTML body, without running scripts or loading images. */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, head').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach((el) => el.append('\n'));
  return (doc.body?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

export function snippetOf(text, length = 140) {
  return text.replace(/\s+/g, ' ').trim().slice(0, length);
}
