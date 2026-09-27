/**
 * Touch gestures for the message list: swipe a row sideways, long-press to
 * select, and pull down at the top to refresh.
 */

const SWIPE_START_PX = 12;
const SWIPE_COMMIT_FRACTION = 0.35;
const LONG_PRESS_MS = 450;
const PULL_TRIGGER_PX = 72;
// A long press or swipe re-renders rows under the finger, so the click that
// follows may land on a replaced element; block clicks briefly instead.
const CLICK_BLOCK_MS = 400;

/**
 * Swipe and long-press on `.vlist__row` elements inside `container`.
 * Rows need `touch-action: pan-y` so the browser keeps vertical scrolling.
 *
 * @param {object} handlers
 * @param {(row: HTMLElement) => { left?: string, right?: string }} handlers.swipeActions  allowed action per direction
 * @param {(row: HTMLElement, action: string) => void} handlers.onSwipe
 * @param {(row: HTMLElement) => void} handlers.onLongPress
 * @param {(paused: boolean) => void} handlers.onActive  pause list re-rendering during a gesture
 */
export function attachRowGestures(container, { swipeActions, onSwipe, onLongPress, onActive }) {
  let gesture = null;
  let blockClicksUntil = 0;
  const blockClicks = () => {
    blockClicksUntil = performance.now() + CLICK_BLOCK_MS;
  };

  function reset() {
    if (!gesture) return;
    clearTimeout(gesture.timer);
    gesture = null;
    onActive(false);
  }

  container.addEventListener('pointerdown', (event) => {
    const row = event.target.closest('.vlist__row[data-id]');
    if (!row || event.button !== 0) return;
    gesture = {
      row,
      content: row.querySelector('.message-row'),
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      swiping: false,
      actions: swipeActions(row),
      pointerId: event.pointerId,
      timer: setTimeout(() => {
        if (!gesture || gesture.swiping) return;
        blockClicks();
        navigator.vibrate?.(10);
        onLongPress(row);
        reset();
      }, LONG_PRESS_MS),
    };
  });

  container.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;

    if (!gesture.swiping) {
      if (Math.abs(dy) > SWIPE_START_PX) {
        reset(); // vertical scroll: not ours
        return;
      }
      const direction = dx > 0 ? 'right' : 'left';
      if (Math.abs(dx) < SWIPE_START_PX || !gesture.actions[direction]) return;
      gesture.swiping = true;
      clearTimeout(gesture.timer);
      gesture.row.setPointerCapture(event.pointerId);
      onActive(true);
    }

    const direction = dx > 0 ? 'right' : 'left';
    gesture.dx = gesture.actions[direction] ? dx : 0;
    gesture.row.dataset.swipe = direction;
    gesture.row.dataset.swipeAction = gesture.actions[direction] ?? '';
    gesture.content.style.transform = `translateX(${gesture.dx}px)`;
    gesture.row.classList.toggle(
      'vlist__row--armed',
      Math.abs(gesture.dx) > gesture.row.offsetWidth * SWIPE_COMMIT_FRACTION,
    );
  });

  function finish() {
    if (!gesture) return;
    const { row, content, dx, swiping, actions } = gesture;
    if (swiping) {
      blockClicks();
      const width = row.offsetWidth;
      const direction = dx > 0 ? 'right' : 'left';
      const commit = Math.abs(dx) > width * SWIPE_COMMIT_FRACTION && actions[direction];
      content.style.transition = 'transform 180ms ease-out';
      content.style.transform = commit ? `translateX(${dx > 0 ? width : -width}px)` : '';
      setTimeout(() => {
        row.classList.remove('vlist__row--armed');
        if (commit) onSwipe(row, actions[direction]);
        else {
          content.style.transition = '';
          delete row.dataset.swipe;
        }
        reset();
      }, 180);
    } else {
      reset();
    }
  }

  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', () => {
    if (gesture?.swiping) finish();
    else reset();
  });

  // Right-click (mouse, tablets with keyboards) selects, like a long press.
  container.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.vlist__row[data-id]');
    if (!row) return;
    event.preventDefault();
    reset();
    onLongPress(row);
  });

  // A swipe or long press must not also open the message.
  container.ownerDocument.addEventListener(
    'click',
    (event) => {
      if (performance.now() > blockClicksUntil) return;
      blockClicksUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

/**
 * Pull-to-refresh. Uses touch events because the browser claims pointer
 * streams for its own overscroll effect at the top of a scroller.
 */
export function attachPullToRefresh(scroller, indicator, onRefresh) {
  let startY = null;
  let distance = 0;

  scroller.addEventListener(
    'touchstart',
    (event) => {
      startY = scroller.scrollTop <= 0 ? event.touches[0].clientY : null;
      distance = 0;
    },
    { passive: true },
  );

  scroller.addEventListener(
    'touchmove',
    (event) => {
      if (startY == null) return;
      const pulled = event.touches[0].clientY - startY;
      if (pulled <= 0 || scroller.scrollTop > 0) {
        distance = 0;
        indicator.style.transform = '';
        return;
      }
      event.preventDefault();
      distance = Math.min(pulled * 0.5, PULL_TRIGGER_PX * 1.5);
      indicator.style.transform = `translateY(${distance}px) rotate(${distance * 4}deg)`;
      indicator.classList.toggle('pull-indicator--armed', distance >= PULL_TRIGGER_PX);
      indicator.hidden = false;
    },
    { passive: false },
  );

  scroller.addEventListener('touchend', () => {
    if (startY == null) return;
    startY = null;
    indicator.style.transition = 'transform 200ms ease-out';
    indicator.style.transform = '';
    setTimeout(() => {
      indicator.style.transition = '';
      indicator.hidden = true;
      indicator.classList.remove('pull-indicator--armed');
    }, 200);
    if (distance >= PULL_TRIGGER_PX) onRefresh();
    distance = 0;
  });
}
