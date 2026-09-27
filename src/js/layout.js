/**
 * Window width classes (PLAN.md §4.9). Breakpoints must match css/layout.css.
 * CSS does the actual layout; JS uses the class for behaviour, such as whether
 * selecting a thread replaces the list or opens beside it.
 */
export const WIDTH_CLASSES = [
  { name: 'compact', minWidth: 0, panes: 1 },
  { name: 'medium', minWidth: 600, panes: 2 },
  { name: 'expanded', minWidth: 840, panes: 3 },
  { name: 'large', minWidth: 1200, panes: 3 },
];

export function widthClassFor(width) {
  let match = WIDTH_CLASSES[0];
  for (const widthClass of WIDTH_CLASSES) {
    if (width >= widthClass.minWidth) match = widthClass;
  }
  return match.name;
}

export function paneCount(widthClassName) {
  return WIDTH_CLASSES.find((c) => c.name === widthClassName)?.panes ?? 1;
}

/** Whether the navigation drawer is a modal overlay (vs. permanently visible). */
export function isDrawerModal(widthClassName) {
  return paneCount(widthClassName) < 3;
}

/**
 * Keeps `store.widthClass` and `root.dataset.widthClass` in sync with the
 * window size. Returns a function that stops watching.
 */
export function watchWidthClass({ root, store, win = window }) {
  const queries = WIDTH_CLASSES.slice(1).map((c) => win.matchMedia(`(min-width: ${c.minWidth}px)`));

  function update() {
    const widthClass = widthClassFor(win.innerWidth);
    root.dataset.widthClass = widthClass;
    store.set({ widthClass });
  }

  for (const query of queries) query.addEventListener('change', update);
  update();

  return () => {
    for (const query of queries) query.removeEventListener('change', update);
  };
}

export const MIN_LIST_WIDTH = 280;
const MIN_READING_WIDTH = 320;
const DRAWER_WIDTH = 320;

/** Space taken by the permanent drawer in this width class. */
export function drawerWidthFor(widthClassName) {
  return isDrawerModal(widthClassName) ? 0 : DRAWER_WIDTH;
}

/** Keeps the list pane between its minimum and leaving room for the reading pane. */
export function clampListWidth(width, windowWidth, widthClassName) {
  const max = windowWidth - drawerWidthFor(widthClassName) - MIN_READING_WIDTH;
  return Math.round(Math.max(MIN_LIST_WIDTH, Math.min(width, max)));
}

/**
 * On a foldable with a vertical, separating hinge (half-open like a book, or
 * a dual-screen device), the list ends where the hinge starts so no content
 * sits across it. Returns null when the fold doesn't affect the layout.
 */
export function listWidthForFold(fold, windowWidth, widthClassName) {
  if (!fold || fold.orientation !== 'vertical' || !fold.separating) return null;
  if (paneCount(widthClassName) < 2) return null;
  const width = fold.left - drawerWidthFor(widthClassName);
  if (width < MIN_LIST_WIDTH || windowWidth - fold.right < MIN_READING_WIDTH) return null;
  return Math.round(width);
}
