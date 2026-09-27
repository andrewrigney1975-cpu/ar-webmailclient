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
