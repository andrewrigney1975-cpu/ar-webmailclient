import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../src/js/store.js';

describe('createStore', () => {
  it('merges patches and notifies with the new and previous state', () => {
    const store = createStore({ a: 1, b: 2 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ a: 3 });

    expect(store.get()).toEqual({ a: 3, b: 2 });
    expect(listener).toHaveBeenCalledWith({ a: 3, b: 2 }, { a: 1, b: 2 });
  });

  it('accepts a patch function', () => {
    const store = createStore({ count: 1 });
    store.set((state) => ({ count: state.count + 1 }));
    expect(store.get().count).toBe(2);
  });

  it('skips notification when nothing changed', () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ a: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.set({ a: 2 });

    expect(listener).not.toHaveBeenCalled();
  });
});
