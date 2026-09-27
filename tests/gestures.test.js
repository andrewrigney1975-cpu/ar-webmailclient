import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPullToRefresh, attachRowGestures } from '../src/js/views/components/gestures.js';

// jsdom has no PointerEvent; a MouseEvent with a pointerId is enough for these handlers.
function pointer(target, type, x, y) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}

function setup(actions = { left: 'trash', right: 'archive' }) {
  document.body.innerHTML = `
    <div class="vlist">
      <div class="vlist__row" data-id="7"><a class="message-row" href="#/open">Row</a></div>
    </div>`;
  const container = document.querySelector('.vlist');
  const row = container.querySelector('.vlist__row');
  row.setPointerCapture = () => {};
  Object.defineProperty(row, 'offsetWidth', { value: 400 });
  const handlers = {
    swipeActions: vi.fn(() => actions),
    onSwipe: vi.fn(),
    onLongPress: vi.fn(),
    onActive: vi.fn(),
  };
  attachRowGestures(container, handlers);
  return { container, row, link: row.querySelector('a'), handlers };
}

function click(link) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('row gestures', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('commits a swipe past the threshold and blocks the following click', () => {
    const { link, row, handlers } = setup();
    pointer(link, 'pointerdown', 10, 20);
    for (let x = 30; x <= 250; x += 20) pointer(link, 'pointermove', x, 22);
    expect(row.dataset.swipe).toBe('right');
    expect(row.classList.contains('vlist__row--armed')).toBe(true);
    expect(handlers.onActive).toHaveBeenCalledWith(true);

    pointer(link, 'pointerup', 250, 22);
    vi.advanceTimersByTime(200);
    expect(handlers.onSwipe).toHaveBeenCalledWith(row, 'archive');
    expect(click(link)).toBe(true);
  });

  it('snaps back a short swipe', () => {
    const { link, row, handlers } = setup();
    pointer(link, 'pointerdown', 10, 20);
    pointer(link, 'pointermove', -60, 20);
    expect(row.dataset.swipe).toBe('left');
    pointer(link, 'pointerup', -60, 20);
    vi.advanceTimersByTime(200);
    expect(handlers.onSwipe).not.toHaveBeenCalled();
    expect(row.dataset.swipe).toBeUndefined();
  });

  it('ignores a direction with no action', () => {
    const { link, row, handlers } = setup({ left: 'trash' });
    pointer(link, 'pointerdown', 10, 20);
    pointer(link, 'pointermove', 200, 20);
    expect(row.dataset.swipe).toBeUndefined();
    expect(handlers.onActive).not.toHaveBeenCalled();
  });

  it('leaves vertical scrolling alone', () => {
    const { link, handlers } = setup();
    pointer(link, 'pointerdown', 10, 20);
    pointer(link, 'pointermove', 14, 80);
    vi.advanceTimersByTime(1000);
    expect(handlers.onLongPress).not.toHaveBeenCalled();
    expect(click(link)).toBe(false);
  });

  it('selects on long press and blocks only the click that follows', () => {
    const { link, row, handlers } = setup();
    pointer(link, 'pointerdown', 10, 20);
    vi.advanceTimersByTime(500);
    expect(handlers.onLongPress).toHaveBeenCalledWith(row);
    pointer(link, 'pointerup', 10, 20);

    expect(click(link)).toBe(true);
    expect(click(link)).toBe(false);
  });

  it('does not block a later tap if no click followed the long press', () => {
    const { link } = setup();
    pointer(link, 'pointerdown', 10, 20);
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(1000);
    expect(click(link)).toBe(false);
  });

  it('treats right-click as a long press', () => {
    const { link, row, handlers } = setup();
    link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(handlers.onLongPress).toHaveBeenCalledWith(row);
  });
});

describe('pull to refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function touch(target, type, y) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
    target.dispatchEvent(event);
    return event;
  }

  function setupPull() {
    document.body.innerHTML = '<div class="scroller"><div class="pull-indicator" hidden></div></div>';
    const scroller = document.querySelector('.scroller');
    const onRefresh = vi.fn();
    attachPullToRefresh(scroller, scroller.querySelector('.pull-indicator'), onRefresh);
    return { scroller, onRefresh };
  }

  it('refreshes after a long enough pull at the top', () => {
    const { scroller, onRefresh } = setupPull();
    touch(scroller, 'touchstart', 100);
    const move = touch(scroller, 'touchmove', 300);
    expect(move.defaultPrevented).toBe(true);
    touch(scroller, 'touchend');
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('ignores short pulls and pulls that start scrolled down', () => {
    const { scroller, onRefresh } = setupPull();
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 150);
    touch(scroller, 'touchend');

    scroller.scrollTop = 200;
    Object.defineProperty(scroller, 'scrollTop', { value: 200 });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 400);
    touch(scroller, 'touchend');
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('sheets and dialogs', () => {
  // jsdom has no showModal/close; a minimal stand-in that never fires "close",
  // like a browser that defers it while the page is hidden.
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
  });

  async function load() {
    const { chooseFromSheet, confirmDialog } = await import('../src/js/views/components/overlays.js');
    const { createRouter } = await import('../src/js/router.js');
    const win = { location: { hash: '#/settings', replace() {} }, addEventListener() {} };
    return { chooseFromSheet, confirmDialog, router: createRouter({ onChange: () => {}, win }) };
  }

  it('resolves with the chosen item without waiting for a close event', async () => {
    const { chooseFromSheet, router } = await load();
    const choice = chooseFromSheet(router, { title: 'Pick', items: [{ heading: 'Group' }, { value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
    document.querySelector('dialog.sheet [data-index="2"]').click();
    expect(await choice).toBe('b');
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('resolves null on the back gesture, and confirm dialogs resolve booleans', async () => {
    const { chooseFromSheet, confirmDialog, router } = await load();
    const choice = chooseFromSheet(router, { title: 'Pick', items: [{ value: 'a', label: 'A' }] });
    expect(router.back()).toBe(true);
    expect(await choice).toBeNull();

    const confirmed = confirmDialog(router, { title: 'Sure?', message: '', confirm: 'Yes' });
    document.querySelector('dialog button[value=confirm]').click();
    expect(await confirmed).toBe(true);
  });
});
