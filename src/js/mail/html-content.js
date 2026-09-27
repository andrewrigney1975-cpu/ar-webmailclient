/**
 * Prepares email HTML for display (PLAN.md §4.8, §5):
 *   - DOMPurify removes scripts, event handlers, forms, frames and embeds
 *   - remote resources are detected so the UI can offer "Load images";
 *     blocking itself is done by the frame's CSP, which also covers CSS url()
 *   - cid: references are swapped for local URLs of inline attachments
 *   - links are marked so the reader can open them outside the app
 * The result is rendered in a sandboxed iframe without script permission.
 */
import DOMPurify from 'dompurify';

const FORBID_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button',
  'select', 'textarea', 'base', 'link', 'meta', 'audio', 'video', 'source', 'track', 'portal',
];
const FORBID_ATTR = ['srcset', 'ping', 'formaction', 'action'];
const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*['"]?\s*(https?:)?\/\//i;

// Where the quoted part of a reply starts, per mail client. Markers that are
// a header rather than a container fold themselves and everything after them.
const QUOTE_CONTAINERS = ['.gmail_quote', 'blockquote[type="cite"]', '.yahoo_quoted', '.protonmail_quote'];
const QUOTE_MARKERS = ['#divRplyFwdMsg', '#appendonsend', '.moz-cite-prefix'];

/**
 * Wraps the quoted part of a reply in a collapsed <details>. Only when
 * something comes before it, so a plain forward isn't hidden entirely.
 */
function foldQuote(doc) {
  const container = doc.body.querySelector(QUOTE_CONTAINERS.join(','));
  const marker = doc.body.querySelector(QUOTE_MARKERS.join(','));
  const first = [container, marker]
    .filter(Boolean)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
  if (!first) return false;

  const range = doc.createRange();
  range.setStart(doc.body, 0);
  range.setEndBefore(first);
  if (!range.toString().trim()) return false;

  const details = doc.createElement('details');
  details.className = 'despatch-quote';
  const summary = doc.createElement('summary');
  summary.textContent = 'Show quoted text';
  details.append(summary);

  first.parentNode.insertBefore(details, first);
  if (first === marker) {
    while (details.nextSibling) details.append(details.nextSibling);
  } else {
    details.append(first);
  }
  return true;
}

/**
 * @param {string} html  raw message HTML
 * @param {object} options
 * @param {Map<string, string>} [options.inlineImages]  Content-ID → local URL
 * @param {boolean} [options.foldQuotes]  collapse the quoted part of replies
 * @returns {{ html: string, head: string, hasRemoteContent: boolean }}
 */
export function prepareHtml(html, { inlineImages = new Map(), foldQuotes = false } = {}) {
  const doc = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_TAGS: ['style'],
    ADD_URI_SAFE_ATTR: ['background'],
    ALLOWED_URI_REGEXP: /^(?:https?:|\/\/|mailto:|tel:|cid:|data:image\/(?:png|gif|jpe?g|webp);|#)/i,
  }).ownerDocument;

  let hasRemoteContent = false;

  for (const element of doc.querySelectorAll('[src], [background], [poster]')) {
    for (const attribute of ['src', 'background', 'poster']) {
      const value = element.getAttribute(attribute);
      if (value == null) continue;
      if (/^cid:/i.test(value)) {
        const local = inlineImages.get(value.slice(4).replace(/^<|>$/g, '').toLowerCase());
        if (local) element.setAttribute(attribute, local);
        else element.removeAttribute(attribute);
      } else if (REMOTE_URL.test(value)) {
        hasRemoteContent = true;
        // Protocol-relative URLs have no meaningful base inside the frame.
        if (value.trim().startsWith('//')) element.setAttribute(attribute, `https:${value.trim()}`);
      }
    }
  }

  for (const element of doc.querySelectorAll('[style]')) {
    if (CSS_REMOTE_URL.test(element.getAttribute('style'))) hasRemoteContent = true;
  }
  for (const style of doc.querySelectorAll('style')) {
    if (CSS_REMOTE_URL.test(style.textContent) || /@import/i.test(style.textContent)) hasRemoteContent = true;
  }

  for (const link of doc.querySelectorAll('a[href]')) {
    link.setAttribute('rel', 'noopener noreferrer');
    link.removeAttribute('target');
  }

  if (foldQuotes) foldQuote(doc);

  return { html: doc.body.innerHTML, head: doc.head.innerHTML, hasRemoteContent };
}

const ATTRIBUTION = [
  /^On .{4,200} wrote:\s*$/,
  /^Am .{4,200} schrieb .{1,100}:\s*$/,
  /^Le .{4,200} a écrit\s*:\s*$/,
  /^El .{4,200} escribió:\s*$/,
  /^Op .{4,200} schreef .{1,100}:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  // Outlook-style header block; only counts when followed by Sent: or Date:.
  /^From: .+$/,
];

/**
 * Splits a plain-text body into what the sender wrote, the quoted reply
 * history, and the signature ("-- " delimiter, RFC 3676).
 */
export function splitPlainText(text) {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');

  let quoteStart = lines.findIndex((line, i) => {
    const trimmed = line.trim();
    if (!ATTRIBUTION.some((pattern) => pattern.test(trimmed))) return false;
    if (trimmed.startsWith('From: ')) return /^(Sent|Date): /.test(lines[i + 1]?.trim() ?? '');
    return true;
  });
  // Otherwise, a block of "> " lines running to the end.
  if (quoteStart === -1) {
    let i = lines.length - 1;
    while (i >= 0 && !lines[i].trim()) i--;
    while (i >= 0 && (lines[i].startsWith('>') || !lines[i].trim())) {
      if (lines[i].startsWith('>')) quoteStart = i;
      i--;
    }
  }
  if (quoteStart === 0) quoteStart = -1; // all quote: nothing to fold

  const main = quoteStart > 0 ? lines.slice(0, quoteStart) : lines;
  const quote = quoteStart > 0 ? lines.slice(quoteStart).join('\n').trim() : '';

  const signatureStart = main.lastIndexOf('-- ');
  const body = (signatureStart > 0 ? main.slice(0, signatureStart) : main).join('\n').trim();
  const signature = signatureStart > 0 ? main.slice(signatureStart + 1).join('\n').trim() : '';

  return { body, quote, signature };
}

/**
 * Builds the srcdoc for the message frame. The CSP here narrows the app's own
 * policy: nothing may load except inline styles, data: and local images, and
 * remote images only when the user allowed them.
 */
export function buildFrameDocument({ head, html }, { allowRemote = false, appOrigin = location.origin } = {}) {
  const images = ["'self'", 'data:', 'blob:', appOrigin, allowRemote ? 'https: http:' : ''].filter(Boolean).join(' ');
  const csp = `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; form-action 'none'`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="color-scheme" content="light">
<style>
  html { background: #fff; color: #1a1c20; }
  body { margin: 0; padding: 16px; font: 15px/1.5 system-ui, Roboto, sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; }
  details.despatch-quote { margin-top: 12px; }
  details.despatch-quote > summary {
    display: inline-block; padding: 2px 10px; border-radius: 12px; background: #e8eaf0;
    color: #44474e; font: 13px system-ui, sans-serif; cursor: pointer; list-style: none;
  }
  details.despatch-quote > summary::-webkit-details-marker { display: none; }
  details.despatch-quote[open] > summary { margin-bottom: 8px; }
</style>
${head}
</head>
<body>${html}</body>
</html>`;
}
