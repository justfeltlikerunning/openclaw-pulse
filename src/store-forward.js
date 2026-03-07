/**
 * store-forward.js — StoreForwardQueue: queue undeliverable messages for later retry
 *
 * When a message cannot be delivered (no live path to target), it enters
 * this queue. When a peer reconnects, flushFor() retries all queued messages
 * routable through that peer.
 *
 * Spec ref: DPWP/1.0 Section 5.3 — Store-and-Forward Queue
 *
 * Constraints:
 *   - Max 100 messages total
 *   - Per-message TTL: 1 hour (3,600,000 ms by default)
 *   - On overflow: evict oldest, send route-error to originator
 *   - On TTL expiry: send route-error to originator
 *   - Flush: re-run routing on queued messages when a peer reconnects
 *
 * Usage:
 *   const sfq = new StoreForwardQueue({ route, sendRouteError });
 *   sfq.enqueue(envelope);                 // queue it
 *   sfq.flushFor('agent-d');                 // peer reconnected — retry
 *   sfq.purgeExpired();                    // periodic cleanup
 */

export class StoreForwardQueue {
  /**
   * @param {object} opts
   * @param {Function} opts.route           route(envelope) — MeshRouter.route()
   * @param {Function} opts.sendRouteError  sendRouteError(envelope, reason) — optional
   * @param {number}   opts.maxSize         Max queued messages (default 100)
   * @param {number}   opts.ttlMs           Per-message TTL in ms (default 1 hour)
   */
  constructor({ route, sendRouteError, maxSize = 100, ttlMs = 3_600_000 } = {}) {
    if (typeof route !== 'function') {
      throw new Error('StoreForwardQueue requires a route() callback');
    }

    this.route          = route;
    this.sendRouteError = sendRouteError || (() => {});
    this.maxSize        = maxSize;
    this.ttlMs          = ttlMs;

    /**
     * @type {Array<{ envelope: object, queuedAt: number, targetNodeId: string }>}
     */
    this.queue = [];
  }

  /**
   * Enqueue an undeliverable envelope.
   *
   * Purges expired entries first. If still at capacity, evicts oldest
   * and fires a route-error for the evicted message.
   *
   * @param {object} envelope  pulse/2.0 envelope
   */
  enqueue(envelope) {
    this.purgeExpired();

    if (this.queue.length >= this.maxSize) {
      const evicted = this.queue.shift();
      console.warn(`[mesh:sfq] Queue overflow — evicting ${evicted.envelope.messageId} (target: ${evicted.targetNodeId})`);
      this.sendRouteError(evicted.envelope, 'queue_overflow');
    }

    this.queue.push({
      envelope,
      queuedAt:     Date.now(),
      targetNodeId: envelope.to,
    });

    console.log(`[mesh:message-queued] messageId=${envelope.messageId} to=${envelope.to} queueSize=${this.queue.length}`);
  }

  /**
   * Flush queued messages that can be routed through (or to) the reconnected node.
   *
   * Called by PeerManager.onPeerReconnected(). Removes flushed items from the
   * queue and re-runs route() on each one.
   *
   * @param {string} nodeId  The peer that just reconnected
   */
  flushFor(nodeId) {
    const now = Date.now();

    // Collect messages either directly targeting this peer OR where we can
    // attempt re-routing (anything still within TTL — MeshRouter will decide
    // if the path is now available).
    const toFlush = this.queue.filter(item => {
      // Skip expired (purgeExpired() wasn't called this cycle yet)
      if (now - item.queuedAt > this.ttlMs) return false;
      // Direct target match
      if (item.targetNodeId === nodeId) return true;
      // Opportunistic: re-try all queued messages through this newly-alive peer.
      // MeshRouter will drop again if still unroutable — but don't flood, only
      // flush those whose target we wouldn't have been able to reach before.
      // For Phase 1 simplicity, we only flush direct-target matches.
      return item.targetNodeId === nodeId;
    });

    if (toFlush.length === 0) return;

    // Remove flushed items from queue before routing (prevent re-queuing loops)
    const toFlushSet = new Set(toFlush.map(i => i.envelope.messageId));
    this.queue = this.queue.filter(item => !toFlushSet.has(item.envelope.messageId));

    for (const item of toFlush) {
      const durationMs = now - item.queuedAt;
      console.log(`[mesh:message-flushed] messageId=${item.envelope.messageId} to=${item.targetNodeId} queuedDurationMs=${durationMs}`);
      // Re-run routing — if it fails again, route() will re-enqueue.
      try {
        this.route(item.envelope);
      } catch (err) {
        console.error(`[mesh:sfq] Flush route error for ${item.envelope.messageId}: ${err.message}`);
      }
    }
  }

  /**
   * Evict all messages whose TTL has elapsed.
   * Should be called periodically (e.g., every minute) and before enqueue().
   */
  purgeExpired() {
    const now     = Date.now();
    const expired = this.queue.filter(item => now - item.queuedAt > this.ttlMs);

    if (expired.length === 0) return;

    this.queue = this.queue.filter(item => now - item.queuedAt <= this.ttlMs);

    for (const item of expired) {
      console.log(`[mesh:sfq] Purged expired message ${item.envelope.messageId} (target: ${item.targetNodeId})`);
      this.sendRouteError(item.envelope, 'ttl_expired_in_queue');
    }
  }

  /**
   * Number of queued messages.
   * @returns {number}
   */
  get size() {
    return this.queue.length;
  }

  /**
   * Clear all queued messages (testing / forced reset).
   */
  clear() {
    this.queue = [];
  }
}
