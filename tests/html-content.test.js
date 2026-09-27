import { describe, expect, it } from 'vitest';
import { buildFrameDocument, prepareHtml, splitPlainText } from '../src/js/mail/html-content.js';

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

describe('quote folding', () => {
  it('folds a Gmail quote but keeps what was written above it', () => {
    const { html } = prepareHtml(
      '<div>Sounds good!</div><div class="gmail_quote"><div>On Mon, Bob wrote:</div><blockquote>Earlier</blockquote></div>',
      { foldQuotes: true },
    );
    const out = parse(html);
    expect(out.querySelector('details.despatch-quote .gmail_quote')).not.toBeNull();
    expect(out.firstElementChild.textContent).toBe('Sounds good!');
  });

  it('folds everything after an Outlook reply header', () => {
    const { html } = prepareHtml('<p>Thanks</p><div id="divRplyFwdMsg">From: Bob</div><p>Old text</p><p>Older</p>', {
      foldQuotes: true,
    });
    const details = parse(html).querySelector('details.despatch-quote');
    expect(details.textContent).toContain('From: Bob');
    expect(details.textContent).toContain('Older');
  });

  it('does not fold a message that is only a quote', () => {
    const { html } = prepareHtml('<blockquote type="cite">Forwarded text</blockquote>', { foldQuotes: true });
    expect(parse(html).querySelector('details')).toBeNull();
  });
});

describe('splitPlainText', () => {
  it('separates the reply, the attribution-led quote and the signature', () => {
    const text = 'Yes, Friday works.\n\n-- \nAlice\n0400 000 000\n\nOn Mon, 5 Oct 2026, Bob wrote:\n> Can we meet?\n> Friday?';
    expect(splitPlainText(text)).toEqual({
      body: 'Yes, Friday works.',
      signature: 'Alice\n0400 000 000',
      quote: 'On Mon, 5 Oct 2026, Bob wrote:\n> Can we meet?\n> Friday?',
    });
  });

  it('treats trailing quoted lines as a quote', () => {
    expect(splitPlainText('Agreed.\n\n> earlier line\n> another')).toMatchObject({
      body: 'Agreed.',
      quote: '> earlier line\n> another',
    });
  });

  it('recognises Outlook headers and other languages', () => {
    expect(splitPlainText('Ok\nFrom: Bob\nSent: Monday\nSubject: x').quote).toMatch(/^From: Bob/);
    expect(splitPlainText('Ja\nAm 5. Okt. 2026 schrieb Bob <b@x.de>:\n> Hallo').quote).toMatch(/^Am 5/);
    expect(splitPlainText('Just text\nFrom: here to there').quote).toBe('');
  });

  it('leaves plain messages and all-quote messages alone', () => {
    expect(splitPlainText('Hello\n> not a quote\nMore text')).toEqual({
      body: 'Hello\n> not a quote\nMore text',
      quote: '',
      signature: '',
    });
    expect(splitPlainText('> only quoted').body).toBe('> only quoted');
  });
});
