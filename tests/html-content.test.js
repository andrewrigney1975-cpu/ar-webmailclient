import { describe, expect, it } from 'vitest';
import { buildFrameDocument, prepareHtml } from '../src/js/mail/html-content.js';

function parse(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('prepareHtml', () => {
  it('removes scripts, handlers, forms, frames and dangerous URLs', () => {
    const { html } = prepareHtml(`
      <p onclick="steal()">Hi<script>alert(1)</script></p>
      <img src="x" onerror="alert(2)">
      <form action="https://evil.test"><input name="password"></form>
      <iframe src="https://evil.test"></iframe>
      <a href="javascript:alert(3)">bad</a>
      <object data="x.swf"></object>
      <base href="https://evil.test/">
      <meta http-equiv="refresh" content="0;url=https://evil.test">
    `);
    const out = parse(html);
    expect(out.querySelector('script, form, input, iframe, object, base, meta')).toBeNull();
    expect(out.querySelector('[onclick], [onerror]')).toBeNull();
    expect(out.querySelector('a').getAttribute('href')).toBeNull();
    expect(out.textContent).toContain('Hi');
  });

  it('keeps email styling', () => {
    const { html, head } = prepareHtml(
      '<html><head><style>.x{color:red}</style></head><body><table style="width:600px"><tr><td class="x">Cell</td></tr></table></body></html>',
    );
    expect(head + html).toContain('.x{color:red}');
    expect(parse(html).querySelector('table').getAttribute('style')).toBe('width:600px');
  });

  it('detects remote images, backgrounds and CSS urls', () => {
    expect(prepareHtml('<p>plain</p>').hasRemoteContent).toBe(false);
    expect(prepareHtml('<img src="https://tracker.test/p.gif">').hasRemoteContent).toBe(true);
    const relative = prepareHtml('<img src="//tracker.test/p.gif">');
    expect(relative.hasRemoteContent).toBe(true);
    expect(relative.html).toContain('src="https://tracker.test/p.gif"');
    expect(prepareHtml('<table><tr><td background="http://x.test/bg.png">x</td></tr></table>').hasRemoteContent).toBe(true);
    expect(prepareHtml('<div style="background:url(https://x.test/a.png)">').hasRemoteContent).toBe(true);
    expect(prepareHtml('<style>@import "https://x.test/a.css";</style><p>x</p>').hasRemoteContent).toBe(true);
    expect(prepareHtml('<img src="data:image/png;base64,AAAA">').hasRemoteContent).toBe(false);
  });

  it('replaces cid: images with local URLs and drops unknown ones', () => {
    const { html } = prepareHtml('<img src="cid:Logo@x"><img src="cid:missing">', {
      inlineImages: new Map([['logo@x', 'https://localhost/_capacitor_file_/logo.png']]),
    });
    const [known, missing] = parse(html).querySelectorAll('img');
    expect(known.getAttribute('src')).toBe('https://localhost/_capacitor_file_/logo.png');
    expect(missing.hasAttribute('src')).toBe(false);
  });

  it('marks links so they open outside the message', () => {
    const { html } = prepareHtml('<a href="https://example.com" target="_top">x</a>');
    const link = parse(html).querySelector('a');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.hasAttribute('target')).toBe(false);
  });
});

describe('buildFrameDocument', () => {
  it('blocks remote images unless allowed', () => {
    const blocked = buildFrameDocument({ head: '', html: '<p>x</p>' }, { appOrigin: 'https://localhost' });
    expect(blocked).toMatch(/img-src 'self' data: blob: https:\/\/localhost;/);
    expect(blocked).toContain("default-src 'none'");

    const allowed = buildFrameDocument({ head: '', html: '' }, { allowRemote: true, appOrigin: 'https://localhost' });
    expect(allowed).toMatch(/img-src [^;]*https: http:/);
  });
});
