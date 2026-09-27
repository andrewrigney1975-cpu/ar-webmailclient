import { beforeAll, describe, expect, it, vi } from 'vitest';
import { VirtualList } from '../src/js/views/components/virtual-list.js';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
  };
});

function makeList(total, { clientHeight = 720 } = {}) {
  const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'clientHeight', { value: clientHeight });
  document.body.append(scroller);
  const fetchPage = vi.fn(async (offset, limit) =>
    Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ id: offset + i + 1 })),
  );
  const list = new VirtualList({
    scroller,
    fetchPage,
    renderRow: (item) => `<a class="message-row">Item ${item.id}</a>`,
    pageSize: 50,
    overscan: 5,
    estimatedRowHeight: 72,
  });
  return { list, scroller, fetchPage };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const ids = (list) => [...list.element.querySelectorAll('.vlist__row[data-id]')].map((r) => Number(r.dataset.id));

describe('VirtualList', () => {
  it('renders only the rows in view and loads one page', async () => {
    const { list, fetchPage } = makeList(10_000);
    list.reset(10_000);
    await settle();

    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledWith(0, 50);
    expect(ids(list)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1)); // 10 visible + 5 overscan + 1
    expect(list.element.style.height).toBe(`${10_000 * 72}px`);
  });

  it('loads the page for a deep scroll position', async () => {
    const { list, scroller, fetchPage } = makeList(10_000);
    list.reset(10_000);
    await settle();

    scroller.scrollTop = 5000 * 72;
    list.draw();
    await settle();

    // Rows 4995–5015 span two pages.
    expect(fetchPage).toHaveBeenCalledWith(4950, 50);
    expect(fetchPage).toHaveBeenCalledWith(5000, 50);
    expect(ids(list)).toContain(5001);
    expect(list.element.querySelectorAll('.vlist__row')).toHaveLength(21);
  });

  it('keeps showing old rows while a refresh loads', async () => {
    const { list, fetchPage } = makeList(100);
    list.reset(100);
    await settle();

    let release;
    fetchPage.mockImplementationOnce(() => new Promise((r) => (release = r)));
    list.refresh(100);
    expect(ids(list)[0]).toBe(1); // stale rows, not placeholders
    release([{ id: 99 }]);
    await settle();
    expect(ids(list)[0]).toBe(99);
  });

  it('ignores pages from a previous folder', async () => {
    const { list, fetchPage } = makeList(100);
    let release;
    fetchPage.mockImplementationOnce(() => new Promise((r) => (release = r)));
    list.reset(100);
    list.reset(3);
    await settle();
    release([{ id: 'stale' }]);
    await settle();
    expect(ids(list)).toEqual([1, 2, 3]);
  });
});
