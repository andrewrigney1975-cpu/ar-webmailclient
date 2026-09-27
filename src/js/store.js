/**
 * Minimal observable state store.
 * `set` shallow-merges a patch (or the result of a patch function) and notifies
 * subscribers only when at least one top-level value actually changed.
 */
export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  return {
    get() {
      return state;
    },

    set(patch) {
      const changes = typeof patch === 'function' ? patch(state) : patch;
      const changed = Object.keys(changes).some((key) => !Object.is(changes[key], state[key]));
      if (!changed) return;

      const previous = state;
      state = { ...state, ...changes };
      for (const listener of listeners) listener(state, previous);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
