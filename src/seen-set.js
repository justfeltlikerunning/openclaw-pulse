/**
 * seen-set.js — SeenSet: bounded ring buffer for message deduplication
 *
 * Primary defense against routing loops and duplicate delivery in the mesh.
 * Spec ref: DPWP/1.0 Section 4 — Deduplication (CRITICAL)
 *
 * Design:
 *   - In-memory Map of messageId → expiresAt timestamp
 *   - Insertion-order queue for O(1) FIFO eviction when at capacity
 *   - Per-entry TTL: 4 hours (14,400,000 ms by default)
 *   - Capacity: 10,000 entries by default
 *   - No persistence — UUIDs are unique across restarts anyway
 *
 * Usage:
 *   const seen = new SeenSet();
 *   if (seen.has(envelope.messageId)) return; // drop duplicate
 *   seen.add(envelope.messageId);
 *   // ... process message
 */

export class SeenSet {
  /**
   * @param {number} maxSize  Max entries before oldest is evicted (default 10000)
   * @param {number} ttlMs    Per-entry TTL in ms (default 4 hours)
   */
  constructor(maxSize = 10_000, ttlMs = 14_400_000) {
    this.maxSize = maxSize;
    this.ttlMs   = ttlMs;

    /** @type {Map<string, number>} messageId → expiresAt */
    this.entries = new Map();

    /**
     * Insertion-order queue for eviction.
     * We keep a simple array here; for 10K entries this is fast enough.
     * @type {string[]}
     */
    this.queue = [];
  }

  /**
   * Check if a messageId has been seen (and is not yet expired).
   * Expired entries are lazily evicted on access — no background timer needed.
   *
   * @param {string} messageId
   * @returns {boolean}
   */
  has(messageId) {
    const expiresAt = this.entries.get(messageId);
    if (expiresAt === undefined) return false;

    if (Date.now() > expiresAt) {
      // Lazy eviction: entry expired, treat as unseen.
      // Left in this.queue intentionally — cleaned up on next capacity eviction.
      this.entries.delete(messageId);
      return false;
    }

    return true;
  }

  /**
   * Record a messageId as seen.
   * If already tracked and not expired, this is a no-op.
   * If at capacity, the oldest entry is evicted first.
   *
   * @param {string} messageId
   */
  add(messageId) {
    // If already present and not expired, nothing to do.
    if (this.has(messageId)) return;

    // Evict oldest entries until we have room.
    // Skip queue entries whose IDs have already been lazily deleted from entries map.
    while (this.queue.length >= this.maxSize) {
      const oldest = this.queue.shift();
      this.entries.delete(oldest); // no-op if already lazily evicted
    }

    const expiresAt = Date.now() + this.ttlMs;
    this.entries.set(messageId, expiresAt);
    this.queue.push(messageId);
  }

  /**
   * Approximate entry count (includes lazily-expired entries still in map).
   * O(1). Use for high-frequency checks.
   *
   * @returns {number}
   */
  get size() {
    return this.entries.size;
  }

  /**
   * Exact live count — evicts all expired entries first.
   * O(n) — use sparingly (health endpoint, diagnostics).
   *
   * @returns {number}
   */
  sizeExact() {
    const now = Date.now();
    let evicted = 0;

    for (const [id, expiresAt] of this.entries) {
      if (now > expiresAt) {
        this.entries.delete(id);
        evicted++;
      }
    }

    // Rebuild queue without the evicted entries.
    if (evicted > 0) {
      this.queue = this.queue.filter(id => this.entries.has(id));
    }

    return this.entries.size;
  }

  /**
   * Clear all entries (testing / forced reset).
   */
  clear() {
    this.entries.clear();
    this.queue = [];
  }
}
