interface Entry<V> {
  expiresAt: number;
  value: Promise<V>;
}

/**
 * Small in-process cache for hot metadata (tileset manifests).
 *
 * Concurrent misses for the same key share one in-flight load, so an expiring entry
 * under heavy traffic causes one origin request instead of hundreds. Failed loads are
 * not cached.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const value = load();
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });

    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}
