/**
 * Virtualised list for large mailboxes (PLAN.md §4.6). Only the rows in view
 * (plus a margin) are in the DOM. Items are loaded in pages as the user
 * scrolls. Rows share one height, measured from a rendered row, so the list
 * adapts to the system font size.
 */
export class VirtualList {
  /**
   * @param {object} options
   * @param {HTMLElement} options.scroller  the scrolling element
   * @param {(offset: number, limit: number) => Promise<any[]>} options.fetchPage
   * @param {(item: any, index: number) => string} options.renderRow  HTML for one row's content
   */
  constructor({ scroller, fetchPage, renderRow, pageSize = 50, overscan = 8, estimatedRowHeight = 72 }) {
    this.scroller = scroller;
    this.fetchPage = fetchPage;
    this.renderRow = renderRow;
    this.pageSize = pageSize;
    this.overscan = overscan;
    this.rowHeight = estimatedRowHeight;
    this.count = 0;
    this.pages = new Map();
    this.loading = new Map();
    this.generation = 0;
    this.paused = false;
    this.frame = 0;

    this.element = document.createElement('div');
    this.element.className = 'vlist';
    this.element.setAttribute('role', 'list');
    scroller.append(this.element);

    scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(scroller);
  }

  /** New contents (e.g. another folder): back to the top. */
  reset(count) {
    this.generation += 1;
    this.pages.clear();
    this.loading.clear();
    this.count = count;
    this.scroller.scrollTop = 0;
    this.draw();
  }

  /** Same list, changed data: reload visible pages but keep the scroll position. */
  refresh(count) {
    this.generation += 1;
    this.stale = this.pages;
    this.pages = new Map();
    this.loading.clear();
    this.count = count;
    this.draw();
  }

  item(index) {
    const page = this.pages.get(Math.floor(index / this.pageSize)) ?? this.stale?.get(Math.floor(index / this.pageSize));
    return page?.[index % this.pageSize];
  }

  /** All loaded items (for selection and lookups). */
  loadedItems() {
    return [...this.pages.values()].flat();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  visibleRange() {
    const top = this.scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / this.rowHeight) - this.overscan);
    const last = Math.min(this.count - 1, Math.ceil((top + this.scroller.clientHeight) / this.rowHeight) + this.overscan);
    return [first, last];
  }

  async ensurePage(page) {
    if (this.pages.has(page) || this.loading.has(page)) return;
    const generation = this.generation;
    const request = this.fetchPage(page * this.pageSize, this.pageSize);
    this.loading.set(page, request);
    const items = await request;
    if (generation !== this.generation) return;
    this.loading.delete(page);
    this.pages.set(page, items);
    // Draw now rather than on the next frame: frames don't run while the app is hidden.
    if (!this.paused) this.draw();
  }

  draw() {
    this.element.style.height = `${this.count * this.rowHeight}px`;
    if (this.paused) return;
    if (this.count === 0) {
      this.element.replaceChildren();
      return;
    }

    const [first, last] = this.visibleRange();
    for (let page = Math.floor(first / this.pageSize); page <= Math.floor(last / this.pageSize); page++) {
      this.ensurePage(page);
    }

    let html = '';
    for (let index = first; index <= last; index++) {
      const item = this.item(index);
      html += `<div class="vlist__row" role="listitem" aria-posinset="${index + 1}" aria-setsize="${this.count}"
        data-index="${index}"${item ? ` data-id="${item.id}"` : ''} style="transform: translateY(${index * this.rowHeight}px)">
        ${item ? this.renderRow(item, index) : '<div class="message-row message-row--placeholder"></div>'}
      </div>`;
    }
    this.element.innerHTML = html;

    // Adopt the real row height (it depends on the font scale).
    const sample = this.element.querySelector('.message-row:not(.message-row--placeholder)');
    const measured = sample?.offsetHeight;
    if (measured && Math.abs(measured - this.rowHeight) > 0.5) {
      const anchor = this.scroller.scrollTop / this.rowHeight;
      this.rowHeight = measured;
      this.scroller.scrollTop = anchor * measured;
      this.draw();
    }
  }
}
