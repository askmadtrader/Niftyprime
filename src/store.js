import { useSyncExternalStore } from 'react';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(p) {
      const patch = typeof p === 'function' ? p(state) : p;
      if (!patch) return;
      state = { ...state, ...patch };
      subs.forEach((f) => f());
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}

export function useStore(store, selector) {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
