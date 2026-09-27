import { describe, expect, it } from 'vitest';
import { escapeHtml, html, raw, render } from '../src/js/html.js';

describe('html', () => {
  it('escapes interpolated values', () => {
    const el = document.createElement('div');
    render(el, html`<p title="${'"><script>'}">${'<img src=x onerror=alert(1)>'}</p>`);
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('nests templates and joins arrays without double escaping', () => {
    const items = ['a&b', 'c'].map((t) => html`<li>${t}</li>`);
    const el = document.createElement('ul');
    render(el, html`${items}`);
    expect(el.innerHTML).toBe('<li>a&amp;b</li><li>c</li>');
  });

  it('omits null, undefined and false', () => {
    const el = document.createElement('div');
    render(el, html`${null}${undefined}${false}${0}`);
    expect(el.innerHTML).toBe('0');
  });

  it('passes raw() through untouched', () => {
    const el = document.createElement('div');
    render(el, html`${raw('<b>x</b>')}`);
    expect(el.innerHTML).toBe('<b>x</b>');
  });

  it('escapes quotes', () => {
    expect(escapeHtml(`'"`)).toBe('&#39;&quot;');
  });
});
