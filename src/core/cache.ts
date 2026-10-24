interface Entry<T> {
  promise: Promise<T>;
  expires: number;
}

/**
 * Shares identical requests made within a short window, such as reopening the list or moving
 * between work items. Lives in memory only, so nothing is written to browser storage.
 */
export class ResponseCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(ttlMs = 5 * 60_000, maxEntries = 20, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key: string, load: () => Promise<T>, { refresh = false } = {}): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && !refresh && existing.expires > this.now()) {
      return existing.promise;
    }
    const entry: Entry<T> = { promise: load(), expires: this.now() + this.ttlMs };
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Failed requests are never reused.
    entry.promise.catch(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    return entry.promise;
  }

  clear(): void {
    this.entries.clear();
  }
}
