import { describe, expect, it } from 'vitest';
import { applyAccent, contrastRatio, DEFAULT_ACCENT, onColorFor, parseHex } from '../src/js/theme/theme.js';

describe('parseHex', () => {
  it('parses short and long forms', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('3867D6')).toEqual({ r: 0x38, g: 0x67, b: 0xd6 });
  });

  it('rejects invalid colours', () => {
    expect(() => parseHex('#12')).toThrow();
    expect(() => parseHex('blue')).toThrow();
  });
});

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('picks readable text for the accent', () => {
    expect(onColorFor('#3867d6')).toBe('#ffffff');
    expect(onColorFor('#ffd600')).toBe('#000000');
    expect(onColorFor('#1b5e20')).toBe('#ffffff');
  });
});

describe('applyAccent', () => {
  it('sets the accent and its on-colour', () => {
    const el = document.createElement('div');
    applyAccent(el, '#ffd600');
    expect(el.style.getPropertyValue('--accent')).toBe('#ffd600');
    expect(el.style.getPropertyValue('--on-accent')).toBe('#000000');
  });

  it('falls back to the default accent for invalid input', () => {
    const el = document.createElement('div');
    applyAccent(el, 'not-a-colour');
    expect(el.style.getPropertyValue('--accent')).toBe(DEFAULT_ACCENT);
  });
});
