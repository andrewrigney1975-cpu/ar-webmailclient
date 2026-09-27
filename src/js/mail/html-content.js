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

/**
 * @param {string} html  raw message HTML
 * @param {object} options
 * @param {Map<string, string>} [options.inlineImages]  Content-ID → local URL
 * @returns {{ html: string, hasRemoteContent: boolean }}
 */
export function prepareHtml(html, { inlineImages = new Map() } = {}) {
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

  return { html: doc.body.innerHTML, head: doc.head.innerHTML, hasRemoteContent };
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
</style>
${head}
</head>
<body>${html}</body>
</html>`;
}
