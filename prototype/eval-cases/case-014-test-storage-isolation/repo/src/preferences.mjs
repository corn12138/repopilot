const cache = new Map();

export function createPreferences(storage) {
  return {
    get(key, fallback) {
      if (!cache.has(key)) {
        const raw = storage.get(key);
        cache.set(key, raw === undefined ? fallback : JSON.parse(raw));
      }
      return cache.get(key);
    },
    set(key, value) {
      cache.set(key, value);
      storage.set(key, JSON.stringify(value));
    },
  };
}
