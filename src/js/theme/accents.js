/**
 * Default accent colours for new accounts (PLAN.md §4.5): Material You
 * wallpaper colours first, then a fixed palette, skipping colours already
 * used so accounts are distinguishable from the start.
 */

export const FALLBACK_PALETTE = ['#3867d6', '#20bf6b', '#eb3b5a', '#8854d0', '#fa8231', '#0fb9b1', '#f7b731', '#4b6584'];

export function pickDefaultAccent(usedColors, dynamicColors = []) {
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  const candidates = [...dynamicColors, ...FALLBACK_PALETTE];
  return candidates.find((c) => !used.has(c.toLowerCase())) ?? FALLBACK_PALETTE[used.size % FALLBACK_PALETTE.length];
}
