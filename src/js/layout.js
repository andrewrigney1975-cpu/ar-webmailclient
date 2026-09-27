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
