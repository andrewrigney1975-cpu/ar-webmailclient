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

describe('readable accents', () => {
  it('darkens light accents on light surfaces and lightens dark ones on dark surfaces', async () => {
    const { readableAccent, SURFACES } = await import('../src/js/theme/theme.js');
    for (const accent of ['#ffd600', '#20bf6b', '#3867d6', '#1b1b1b', '#fafafa']) {
      expect(contrastRatio(readableAccent(accent, SURFACES.light), SURFACES.light)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(readableAccent(accent, SURFACES.dark), SURFACES.dark)).toBeGreaterThanOrEqual(4.5);
    }
    // Already readable colours are left alone.
    expect(readableAccent('#1a4fbf', SURFACES.light)).toBe('#1a4fbf');
  });

  it('sets the text accent for both schemes', () => {
    const el = document.createElement('div');
    applyAccent(el, '#ffd600');
    expect(el.style.getPropertyValue('--accent-text')).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  });
});

describe('account updates', () => {
  it('changes only editable fields', async () => {
    const { testDatabase, testAccount } = await import('./helpers.js');
    const { insertAccount, listAccounts, updateAccount } = await import('../src/js/db/repo-accounts.js');
    const db = await testDatabase();
    const account = testAccount();
    await insertAccount(db, account);
    await updateAccount(db, account.id, { accentColor: '#20bf6b', signature: 'Cheers', email: 'hacked@x.io' });
    const [saved] = await listAccounts(db);
    expect(saved).toMatchObject({ accentColor: '#20bf6b', signature: 'Cheers', email: account.email });
  });
});

describe('dark message frames', () => {
  it('adds the inverting style only when asked', async () => {
    const { buildFrameDocument } = await import('../src/js/mail/html-content.js');
    expect(buildFrameDocument({ head: '', html: '' }, { appOrigin: 'x' })).not.toContain('invert(1)');
    expect(buildFrameDocument({ head: '', html: '' }, { dark: true, appOrigin: 'x' })).toContain('invert(1)');
  });
});
