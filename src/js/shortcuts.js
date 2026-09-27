/**
 * Keyboard shortcuts for tablets with keyboards and desktop mode
 * (PLAN.md §4.9). Ignored while typing in a field or with Ctrl/Alt/Meta held.
 */

export const SHORTCUTS = [
  { keys: ['j', 'ArrowDown'], action: 'next', label: 'Next conversation' },
  { keys: ['k', 'ArrowUp'], action: 'previous', label: 'Previous conversation' },
  { keys: ['r'], action: 'reply', label: 'Reply' },
  { keys: ['a'], action: 'replyall', label: 'Reply all' },
  { keys: ['f'], action: 'forward', label: 'Forward' },
  { keys: ['e'], action: 'archive', label: 'Archive' },
  { keys: ['#', 'Delete'], action: 'trash', label: 'Delete' },
  { keys: ['s'], action: 'flag', label: 'Flag or unflag' },
  { keys: ['u'], action: 'unread', label: 'Mark unread' },
  { keys: ['/'], action: 'search', label: 'Search' },
  { keys: ['c'], action: 'compose', label: 'New message' },
  { keys: ['?'], action: 'help', label: 'Show shortcuts' },
];

function isTyping(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

/** The action for a keydown event, or null. */
export function shortcutFor(event) {
  if (event.ctrlKey || event.altKey || event.metaKey || isTyping(event.target)) return null;
  if (document.querySelector('dialog[open]')) return null;
  return SHORTCUTS.find((s) => s.keys.includes(event.key))?.action ?? null;
}

/** @param {(action: string) => boolean | void} run  returns false if the action didn't apply */
export function attachShortcuts(target, run) {
  target.addEventListener('keydown', (event) => {
    const action = shortcutFor(event);
    if (!action) return;
    if (run(action) !== false) event.preventDefault();
  });
}
