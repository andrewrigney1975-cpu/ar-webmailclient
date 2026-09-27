import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDrawerModal, paneCount, WIDTH_CLASSES, widthClassFor } from '../src/js/layout.js';

describe('widthClassFor', () => {
  it.each([
    [360, 'compact'],
    [599, 'compact'],
    [600, 'medium'],
    [839, 'medium'],
    [840, 'expanded'],
    [1199, 'expanded'],
    [1200, 'large'],
    [2560, 'large'],
  ])('%ipx is %s', (width, expected) => {
    expect(widthClassFor(width)).toBe(expected);
  });
});

describe('panes', () => {
  it('uses one, two, then three panes', () => {
    expect(paneCount('compact')).toBe(1);
    expect(paneCount('medium')).toBe(2);
    expect(paneCount('expanded')).toBe(3);
    expect(isDrawerModal('medium')).toBe(true);
    expect(isDrawerModal('expanded')).toBe(false);
  });
});

describe('CSS breakpoints', () => {
  it('match the JS width classes', () => {
    const css = readFileSync(resolve('src/css/layout.css'), 'utf8');
    const cssBreakpoints = [...css.matchAll(/min-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    const jsBreakpoints = WIDTH_CLASSES.slice(1).map((c) => c.minWidth);
    expect([...new Set(cssBreakpoints)].sort((a, b) => a - b)).toEqual(jsBreakpoints);
  });
});

describe('list width', () => {
  it('clamps between the minimum and room for the reading pane', async () => {
    const { clampListWidth, MIN_LIST_WIDTH } = await import('../src/js/layout.js');
    expect(clampListWidth(100, 800, 'medium')).toBe(MIN_LIST_WIDTH);
    expect(clampListWidth(700, 800, 'medium')).toBe(480);
    expect(clampListWidth(700, 1000, 'expanded')).toBe(360); // 1000 - 320 drawer - 320 reading
    expect(clampListWidth(400.4, 1000, 'medium')).toBe(400);
  });

  it('splits along a vertical, separating hinge', async () => {
    const { listWidthForFold } = await import('../src/js/layout.js');
    const book = { orientation: 'vertical', separating: true, left: 420, right: 420 };
    expect(listWidthForFold(book, 840, 'expanded')).toBeNull(); // 420 - 320 drawer is too narrow
    expect(listWidthForFold(book, 840, 'medium')).toBe(420);
    expect(listWidthForFold({ ...book, separating: false }, 840, 'medium')).toBeNull();
    expect(listWidthForFold({ ...book, orientation: 'horizontal' }, 840, 'medium')).toBeNull();
    expect(listWidthForFold(book, 400, 'compact')).toBeNull();
    expect(listWidthForFold(null, 840, 'medium')).toBeNull();
  });
});

describe('keyboard shortcuts', () => {
  it('maps keys to actions, but not while typing or with modifiers', async () => {
    const { shortcutFor } = await import('../src/js/shortcuts.js');
    const key = (k, extra = {}) => ({ key: k, target: document.body, ...extra });
    expect(shortcutFor(key('j'))).toBe('next');
    expect(shortcutFor(key('ArrowUp'))).toBe('previous');
    expect(shortcutFor(key('#'))).toBe('trash');
    expect(shortcutFor(key('?'))).toBe('help');
    expect(shortcutFor(key('x'))).toBeNull();
    expect(shortcutFor(key('r', { ctrlKey: true }))).toBeNull();
    const input = document.createElement('input');
    document.body.append(input);
    expect(shortcutFor(key('r', { target: input }))).toBeNull();
  });
});
