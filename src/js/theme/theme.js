/**
 * System theme and per-account accent colour (PLAN.md §4.5).
 * Light/dark comes from the system via CSS `light-dark()`; this module only
 * applies the account accent and picks readable text for it.
 */

export const DEFAULT_ACCENT = '#3867d6';

export function parseHex(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Invalid hex colour: ${hex}`);

  let digits = match[1];
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  const value = parseInt(digits, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function contrastRatio(hexA, hexB) {
  const [lighter, darker] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Black or white, whichever reads better on the given background. */
export function onColorFor(backgroundHex) {
  return contrastRatio(backgroundHex, '#ffffff') >= contrastRatio(backgroundHex, '#000000')
    ? '#ffffff'
    : '#000000';
}

export function applyAccent(element, hex = DEFAULT_ACCENT) {
  let accent = hex;
  try {
    parseHex(accent);
  } catch {
    accent = DEFAULT_ACCENT;
  }
  element.style.setProperty('--accent', accent);
  element.style.setProperty('--on-accent', onColorFor(accent));
}

/**
 * Keeps `store.colorScheme` ('light' | 'dark') in sync with the system theme.
 * Returns a function that stops watching.
 */
export function watchColorScheme({ store, win = window }) {
  const query = win.matchMedia('(prefers-color-scheme: dark)');
  const update = () => store.set({ colorScheme: query.matches ? 'dark' : 'light' });
  query.addEventListener('change', update);
  update();
  return () => query.removeEventListener('change', update);
}
