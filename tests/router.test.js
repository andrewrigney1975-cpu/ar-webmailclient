import { describe, expect, it, vi } from 'vitest';
import { buildHash, createRouter, parentOf, parseHash, UNIFIED_INBOX } from '../src/js/router.js';

const unified = { name: 'mailbox', folderId: UNIFIED_INBOX, threadId: null };

describe('parseHash', () => {
  it('defaults to the unified inbox', () => {
    expect(parseHash('')).toEqual(unified);
    expect(parseHash('#/')).toEqual(unified);
  });

  it('parses folder and thread routes', () => {
    expect(parseHash('#/folder/acc1%2FINBOX')).toEqual({
      name: 'mailbox',
      folderId: 'acc1/INBOX',
      threadId: null,
    });
    expect(parseHash('#/folder/f1/thread/t9')).toEqual({ name: 'mailbox', folderId: 'f1', threadId: 't9' });
  });

  it('parses settings and rejects unknown routes', () => {
    expect(parseHash('#/settings')).toEqual({ name: 'settings' });
    expect(parseHash('#/nope')).toEqual({ name: 'notFound' });
    expect(parseHash('#/folder/f1/thread')).toEqual({ name: 'notFound' });
  });
});

describe('buildHash', () => {
  it('round-trips through parseHash, including reserved characters', () => {
    const routes = [
      { name: 'mailbox', folderId: 'acc 1/INBOX', threadId: null },
      { name: 'mailbox', folderId: 'f1', threadId: '<id@example.com>' },
      { name: 'settings' },
    ];
    for (const route of routes) expect(parseHash(buildHash(route))).toEqual(route);
  });
});

describe('parentOf', () => {
  it('closes the thread, then returns to the unified inbox, then exits', () => {
    const thread = { name: 'mailbox', folderId: 'f1', threadId: 't1' };
    const folder = parentOf(thread);
    expect(folder).toEqual({ name: 'mailbox', folderId: 'f1', threadId: null });
    expect(parentOf(folder)).toEqual(unified);
    expect(parentOf(unified)).toBeNull();
  });

  it('returns pages to the last mailbox', () => {
    const last = { name: 'mailbox', folderId: 'f2', threadId: 't3' };
    expect(parentOf({ name: 'settings' }, last)).toBe(last);
    expect(parentOf({ name: 'settings' }, null)).toEqual(unified);
  });
});

function fakeWindow(hash = '') {
  const listeners = {};
  const win = {
    location: {
      hash,
      replace: vi.fn((next) => {
        win.location.hash = next;
      }),
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    fire: (type) => listeners[type]?.(),
  };
  return win;
}

describe('createRouter', () => {
  it('closes overlays before navigating back', () => {
    const win = fakeWindow('#/folder/f1/thread/t1');
    const router = createRouter({ onChange: () => {}, win });
    router.start();

    const closeDrawer = vi.fn();
    router.pushOverlay(closeDrawer);

    expect(router.back()).toBe(true);
    expect(closeDrawer).toHaveBeenCalledOnce();
    expect(win.location.replace).not.toHaveBeenCalled();

    expect(router.back()).toBe(true);
    expect(win.location.replace).toHaveBeenCalledWith('#/folder/f1');
  });

  it('unregistered overlays are not closed', () => {
    const win = fakeWindow('#/folder/unified');
    const router = createRouter({ onChange: () => {}, win });
    router.start();

    const close = vi.fn();
    const unregister = router.pushOverlay(close);
    unregister();

    expect(router.back()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('reports the route on hash changes', () => {
    const win = fakeWindow('');
    const onChange = vi.fn();
    const router = createRouter({ onChange, win });
    router.start();

    win.location.hash = '#/settings';
    win.fire('hashchange');

    expect(onChange).toHaveBeenLastCalledWith({ name: 'settings' });
    expect(router.current).toEqual({ name: 'settings' });
  });
});
