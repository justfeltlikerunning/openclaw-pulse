/**
 * mesh-router.js — MeshRouter: core routing logic for DPWP/1.0
 *
 * Wires together SeenSet (dedup), StoreForwardQueue (failure buffering),
 * and PeerManager (outbound connections) to route pulse/2.0 envelopes
 * through the mesh.
 *
 * Spec ref: DPWP/1.0 Section 3 — Message Routing & Relay
 *
 * Algorithm:
 *   route(envelope):
 *     1. Dedup check via SeenSet — drop silently if already seen
 *     2. Mark as seen
 *     3. If we are the target (or broadcast): deliver locally
 *     4. If not sole target: relay()
 *
 *   relay(envelope):
 *     1. TTL check — drop + send route-error if 0
 *     2. Decrement TTL, append self to path[]
 *     3. Try direct delivery to target (if direct peer)
 *     4. Fall back to best relay candidate (exclude path[] nodes, sort by priority)
 *     5. If no candidates: enqueue in store-forward
 *
 * Usage (wired in hub.js):
 *   const router = new MeshRouter({ nodeId, seenSet, peerManager, sfQueue, onDeliver, envelopeCrypto });
 *   router.route(envelope);
 */

import { v4 as uuidv4 } from 'uuid';

// Control message types — never encrypted (routing infrastructure)
const CONTROL_TYPES = new Set([
  'ping', 'pong', 'peer-announce', 'peer-request', 'route-error', 'ack',
]);

export class MeshRouter {
  /**
   * @param {object}   opts
   * @param {string}   opts.nodeId              This node's ID (e.g. "my-agent")
   * @param {object}   opts.seenSet             SeenSet instance
   * @param {object}   opts.peerManager         PeerManager instance
   * @param {object}   opts.sfQueue             StoreForwardQueue instance
   * @param {Function} opts.onDeliver           Called when envelope is for us: onDeliver(envelope)
   * @param {number}   [opts.ttlDefault=3]      Default TTL for originated messages
   * @param {object}   [opts.envelopeCrypto]    EnvelopeCrypto instance for encrypt-by-default
   */
  constructor({ nodeId, seenSet, peerManager, sfQueue, onDeliver, ttlDefault = 3, envelopeCrypto } = {}) {
    if (!nodeId)      throw new Error('MeshRouter requires nodeId');
    if (!seenSet)     throw new Error('MeshRouter requires seenSet');
    if (!peerManager) throw new Error('MeshRouter requires peerManager');
    if (!sfQueue)     throw new Error('MeshRouter requires sfQueue');
    if (typeof onDeliver !== 'function') throw new Error('MeshRouter requires onDeliver callback');

    this.nodeId         = nodeId;
    this.seenSet        = seenSet;
    this.peerManager    = peerManager;
    this.sfQueue        = sfQueue;
    this.onDeliver      = onDeliver;
    this.ttlDefault     = ttlDefault;
    this.envelopeCrypto = envelopeCrypto || null;

    // Stats counters for health endpoint
    this.stats = {
      messagesRouted:    0,
      messagesRelayed:   0,
      messagesDropped:   0,
      messagesQueued:    0,
      messagesEncrypted: 0,
      cryptoWarnCount:   0,
    };
  }

  // ---------------------------------------------------------------------------
  // Public: route an incoming or self-originated pulse/2.0 envelope
  // ---------------------------------------------------------------------------

  /**
   * Entry point for all pulse/2.0 messages.
   *
   * @param {object} envelope  pulse/2.0 envelope
   */
  route(envelope) {
    if (!this._validateEnvelope(envelope)) return;

    const { messageId, to, from } = envelope;

    // 1. Dedup check (skip for ping/pong — they're point-to-point, TTL=1)
    const isControl = (envelope.type === 'ping' || envelope.type === 'pong');
    if (!isControl) {
      if (this.seenSet.has(messageId)) {
        this.stats.messagesDropped++;
        return;
      }
      this.seenSet.add(messageId);
    }

    if (!isControl) {
      console.log(`[mesh:message-received] messageId=${messageId} from=${from} to=${to} type=${envelope.type} ttl=${envelope.ttl} path=${JSON.stringify(envelope.path)}`);
    }
    this.stats.messagesRouted++;

    // 2. Local delivery
    const forUs = (to === this.nodeId || to === '*');
    if (forUs) {
      this.onDeliver(envelope);
    }

    // 3. Relay
    // Relay if: broadcast (to: "*") OR not solely for us
    const shouldRelay = (to === '*') || (to !== this.nodeId);
    if (shouldRelay) {
      this.relay(envelope);
    }
  }

  // ---------------------------------------------------------------------------
  // Relay an envelope to the next hop
  // ---------------------------------------------------------------------------

  /**
   * Relay envelope to the next peer.
   * Mutates a copy of the envelope (decrements TTL, appends self to path).
   *
   * @param {object} envelope  pulse/2.0 envelope (will be copied before mutation)
   */
  relay(envelope) {
    const { messageId, to, ttl, path = [] } = envelope;

    // TTL check
    if (ttl <= 0) {
      console.log(`[mesh:message-dropped] messageId=${messageId} reason=ttl`);
      this.stats.messagesDropped++;
      this._sendRouteError(envelope, 'ttl_expired', path);
      return;
    }

    // Build the forwarded envelope — decrement TTL, append self to path
    const fwd = {
      ...envelope,
      ttl:  ttl - 1,
      path: [...path, this.nodeId],
    };

    // Direct delivery: is target a live direct peer?
    if (to !== '*') {
      const targetPeer = this.peerManager.getPeer(to);
      if (targetPeer && targetPeer.status === 'alive') {
        this._sendToPeer(targetPeer, fwd);
        console.log(`[mesh:message-relayed] messageId=${messageId} to=${to} nextHop=${to} ttl=${fwd.ttl} direct=true`);
        this.stats.messagesRelayed++;
        return;
      }
    }

    // Broadcast: relay to all alive peers not already in path
    if (to === '*') {
      const candidates = this._broadcastCandidates(fwd.path);
      if (candidates.length === 0) {
        // We're a leaf node — broadcast delivered locally above, nothing more to do
        return;
      }
      for (const peer of candidates) {
        this._sendToPeer(peer, fwd);
        console.log(`[mesh:message-relayed] messageId=${messageId} to=* nextHop=${peer.nodeId} ttl=${fwd.ttl}`);
      }
      this.stats.messagesRelayed += candidates.length;
      return;
    }

    // Relay: find best hop toward target
    const candidates = this._relayCandidates(fwd.path, envelope.from);
    if (candidates.length === 0) {
      console.warn(`[mesh:route-error] messageId=${messageId} reason=no_route attemptedPath=${JSON.stringify(fwd.path)}`);
      this.stats.messagesQueued++;
      this.sfQueue.enqueue(envelope); // store original (not decremented) for retry
      this._sendRouteError(envelope, 'no_route', fwd.path);
      return;
    }

    // Send to best candidate (highest priority = lowest number, then lowest latency)
    const best = candidates[0];
    this._sendToPeer(best, fwd);
    console.log(`[mesh:message-relayed] messageId=${messageId} to=${to} nextHop=${best.nodeId} ttl=${fwd.ttl}`);
    this.stats.messagesRelayed++;
  }

  // ---------------------------------------------------------------------------
  // Originate a new pulse/2.0 envelope from this node
  // ---------------------------------------------------------------------------

  /**
   * Create and route a fresh envelope originated by this node.
   * If envelopeCrypto is configured and the message is unicast to a known peer,
   * the payload is automatically encrypted (encrypt-by-default).
   *
   * Encryption is skipped for:
   *   - Broadcast messages (to: "*")
   *   - Control messages (ping, pong, peer-announce, peer-request, route-error, ack)
   *   - Messages already carrying an encrypted block (caller handled it)
   *   - Recipients with unknown public keys (falls back to plaintext + warns)
   *
   * @param {object} opts
   * @param {string} opts.to          Target node ID or "*" for broadcast
   * @param {string} opts.type        Message type (message, ping, pong, etc.)
   * @param {object} opts.payload     Message payload (plaintext)
   * @param {object} [opts.encrypted] Pre-built encrypted block (bypasses auto-encrypt)
   * @param {number} [opts.ttl]       TTL override (defaults to ttlDefault)
   * @param {string} [opts.replyTo]   messageId being replied to
   * @returns {object} The envelope that was originated
   */
  originate({ to, type, payload, encrypted, ttl, replyTo } = {}) {
    const envelope = {
      protocol:  'pulse/2.0',
      messageId: uuidv4(),
      type,
      from:      this.nodeId,
      to,
      ttl:       ttl ?? this.ttlDefault,
      path:      [], // originator doesn't add self yet — relay() will append
      timestamp: Date.now(),
      ...(replyTo ? { replyTo } : {}),
    };

    // Encrypt-by-default logic
    // Conditions to attempt auto-encryption:
    //   1. envelopeCrypto is configured
    //   2. Unicast message (not broadcast)
    //   3. Not a control message type
    //   4. No pre-built encrypted block supplied by caller
    //   5. Not already type "encrypted" (avoid double-encrypt)
    const shouldEncrypt = (
      this.envelopeCrypto &&
      to !== '*' &&
      !CONTROL_TYPES.has(type) &&
      !encrypted &&
      type !== 'encrypted'
    );

    if (shouldEncrypt) {
      if (this.envelopeCrypto.hasPeerKey(to)) {
        const encBlock = this.envelopeCrypto.encrypt(payload || {}, [to]);
        if (encBlock) {
          // Build encrypted envelope: type becomes "encrypted", payload omitted
          envelope.type = 'encrypted';
          envelope.encrypted = encBlock;
          // Note: payload field intentionally absent — ciphertext lives in encrypted.recipients
          this.stats.messagesEncrypted++;
          console.log(`[mesh:crypto] Encrypted message to ${to} (msgId=${envelope.messageId})`);
        } else {
          // encrypt() returned null (key lookup race or internal error) — plaintext fallback
          console.warn(`[mesh:crypto-warn] Encrypt returned null for ${to} — sending plaintext (msgId=${envelope.messageId})`);
          envelope.payload = payload || {};
          this.stats.cryptoWarnCount++;
        }
      } else {
        // No public key on file for recipient — send plaintext with warning
        console.warn(`[mesh:crypto-warn] No public key for ${to} — sending plaintext (msgId=${envelope.messageId})`);
        envelope.payload = payload || {};
        this.stats.cryptoWarnCount++;
      }
    } else if (encrypted) {
      // Caller supplied a pre-built encrypted block (e.g., hub.js reply path)
      envelope.type = 'encrypted';
      envelope.encrypted = encrypted;
    } else {
      // Plaintext: broadcast, control message, or crypto not configured
      envelope.payload = payload || {};
    }

    this.route(envelope);
    return envelope;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate envelope has required pulse/2.0 fields.
   * @param {object} envelope
   * @returns {boolean}
   */
  _validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') {
      console.warn('[mesh] Invalid envelope: not an object');
      return false;
    }
    if (envelope.protocol !== 'pulse/2.0') {
      // Callers should not pass pulse/1.0 here — hub.js filters first
      console.warn(`[mesh] Unexpected protocol: ${envelope.protocol} (expected pulse/2.0)`);
      return false;
    }
    const required = ['messageId', 'type', 'from', 'to', 'ttl', 'timestamp'];
    for (const field of required) {
      if (envelope[field] === undefined || envelope[field] === null) {
        console.warn(`[mesh] Envelope missing required field: ${field}`);
        return false;
      }
    }
    // Ensure path is an array
    if (!Array.isArray(envelope.path)) {
      envelope.path = [];
    }
    return true;
  }

  /**
   * Get alive peers eligible for relaying a unicast message.
   * Excludes nodes already in the path (loop prevention) and the sender.
   *
   * @param {string[]} currentPath  Nodes already in envelope path
   * @param {string}   fromNode     Sender (don't relay back to them)
   * @returns {object[]} Sorted peer objects from PeerManager
   */
  _relayCandidates(currentPath, fromNode) {
    return this.peerManager.getAlivePeers()
      .filter(p => !currentPath.includes(p.nodeId))
      .filter(p => p.nodeId !== fromNode)
      .sort((a, b) => {
        // Sort by priority (lower = preferred), then latency
        const pa = a.priority ?? 99;
        const pb = b.priority ?? 99;
        if (pa !== pb) return pa - pb;
        const la = a.latencyMs ?? 9999;
        const lb = b.latencyMs ?? 9999;
        return la - lb;
      });
  }

  /**
   * Get alive peers for broadcast relay.
   * Excludes nodes already in path (they've already seen it via seenSet,
   * but this saves the extra network hop).
   *
   * @param {string[]} currentPath
   * @returns {object[]}
   */
  _broadcastCandidates(currentPath) {
    return this.peerManager.getAlivePeers()
      .filter(p => !currentPath.includes(p.nodeId));
  }

  /**
   * Send envelope JSON to a peer via their WebSocket.
   *
   * @param {object} peer      Peer object from PeerManager
   * @param {object} envelope  Envelope to send
   */
  _sendToPeer(peer, envelope) {
    try {
      peer.ws.send(JSON.stringify(envelope));
    } catch (err) {
      console.error(`[mesh] Failed to send to ${peer.nodeId}: ${err.message}`);
      // Mark peer as potentially degraded — PeerManager's ping loop will handle it
    }
  }

  /**
   * Send a route-error envelope back to the originator.
   *
   * @param {object}   originalEnvelope
   * @param {string}   reason            'ttl_expired' | 'no_route' | 'target_dead'
   * @param {string[]} attemptedPath
   */
  _sendRouteError(originalEnvelope, reason, attemptedPath = []) {
    const { from, messageId } = originalEnvelope;

    // Don't send route-error back to ourselves (we originated it)
    if (from === this.nodeId) return;

    const errEnvelope = {
      protocol:  'pulse/2.0',
      messageId: uuidv4(),
      type:      'route-error',
      from:      this.nodeId,
      to:        from,
      ttl:       this.ttlDefault,
      path:      [],
      timestamp: Date.now(),
      payload: {
        failedMessageId: messageId,
        reason,
        attemptedPath,
      },
    };

    // Route the error envelope — it gets deduped and forwarded normally
    this.route(errEnvelope);
  }
}
