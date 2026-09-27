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

export function isValidHex(hex) {
  try {
    parseHex(hex);
    return true;
  } catch {
    return false;
  }
}

function toHex({ r, g, b }) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function mix(hexA, hexB, amount) {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  return toHex({ r: a.r + (b.r - a.r) * amount, g: a.g + (b.g - a.g) * amount, b: a.b + (b.b - a.b) * amount });
}

// Surface colours from tokens.css, for checking contrast.
export const SURFACES = { light: '#fdfcff', dark: '#121316' };

/**
 * The accent adjusted for use as text on a surface: mixed towards black
 * (light theme) or white (dark theme) just enough to reach `ratio`.
 */
export function readableAccent(accent, surface, ratio = 4.5) {
  const toward = relativeLuminance(surface) > 0.5 ? '#000000' : '#ffffff';
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(accent, toward, step / 20);
    if (contrastRatio(candidate, surface) >= ratio) return candidate;
  }
  return toward;
}

export function applyAccent(element, hex = DEFAULT_ACCENT) {
  const accent = isValidHex(hex) ? hex : DEFAULT_ACCENT;
  element.style.setProperty('--accent', accent);
  element.style.setProperty('--on-accent', onColorFor(accent));
  element.style.setProperty(
    '--accent-text',
    `light-dark(${readableAccent(accent, SURFACES.light)}, ${readableAccent(accent, SURFACES.dark)})`,
  );
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
