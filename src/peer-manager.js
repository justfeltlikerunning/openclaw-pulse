/**
 * peer-manager.js — PeerManager: mesh peer connection management
 *
 * Loads the pulse-mesh.json config, establishes outbound WebSocket connections
 * to configured peers, and maintains them with ping/pong keepalive and
 * exponential backoff reconnect.
 *
 * Spec ref: DPWP/1.0 Section 2.1, 5.1, 5.2, and Section 7 (State Machine)
 *
 * Peer state machine:
 *   UNVERIFIED → (connect success + first pong) → ALIVE
 *   ALIVE → (3 missed pings) → DEAD
 *   DEAD → (reconnect success + first pong) → ALIVE
 *
 * Usage (wired in hub.js):
 *   const pm = new PeerManager({ nodeId, meshConfig, onMessage, onReconnected });
 *   await pm.connectAll();
 *   const peers = pm.getAlivePeers();
 *   const peer  = pm.getPeer('agent-d');
 */

import { WebSocket } from 'ws';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Default config file location
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'pulse-mesh.json');

// Default mesh config if no config file exists
const DEFAULT_MESH_CONFIG = {
  nodeId: 'my-agent',
  listenPort: 18800,
  peers: [],
  minRelayNodes: 2,
  ttlDefault: 3,
  pingIntervalMs: 30000,
  pingTimeoutMs: 10000,
  deadThresholdMisses: 3,
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    multiplier: 2,
  },
};

// Peer states
export const PeerState = {
  UNVERIFIED: 'unverified',
  ALIVE:      'alive',
  DEAD:       'dead',
};

export class PeerManager {
  /**
   * @param {object}   opts
   * @param {string}   opts.nodeId          This node's ID
   * @param {object}   opts.meshConfig      Loaded pulse-mesh.json content
   * @param {Function} opts.onMessage       Called with (envelope, peerId) for incoming pulse/2.0 messages
   * @param {Function} [opts.onReconnected] Called with (peerId) when a dead peer comes back
   * @param {Function} [opts.onConnected]   Called with (peerId) on first connection
   * @param {Function} [opts.onDisconnected] Called with (peerId) on disconnect
   */
  constructor({ nodeId, meshConfig = {}, onMessage, onReconnected, onConnected, onDisconnected } = {}) {
    if (!nodeId) throw new Error('PeerManager requires nodeId');
    if (typeof onMessage !== 'function') throw new Error('PeerManager requires onMessage callback');

    this.nodeId          = nodeId;
    this.cfg             = { ...DEFAULT_MESH_CONFIG, ...meshConfig };
    this.onMessage       = onMessage;
    this.onReconnected   = onReconnected   || (() => {});
    this.onConnected     = onConnected     || (() => {});
    this.onDisconnected  = onDisconnected  || (() => {});

    /**
     * Map of nodeId → peer state object
     * @type {Map<string, PeerEntry>}
     *
     * PeerEntry shape:
     * {
     *   nodeId:       string,
     *   ip:           string,
     *   port:         number,
     *   priority:     number,
     *   status:       PeerState,
     *   ws:           WebSocket | null,
     *   latencyMs:    number | null,
     *   missedPings:  number,
     *   pingSeq:      number,
     *   pingAt:       number | null,    // timestamp of last ping send
     *   pingTimer:    Timer | null,     // timeout for pong response
     *   reconnTimer:  Timer | null,     // backoff reconnect timer
     *   backoffMs:    number,
     *   connectedAt:  number | null,
     * }
     */
    this.peers = new Map();

    this._pingInterval  = null;
    this._shuttingDown  = false;

    // Initialise peer entries from config
    for (const peerConf of (this.cfg.peers || [])) {
      this._initPeerEntry(peerConf);
    }
  }

  // ---------------------------------------------------------------------------
  // Static: load config from ~/.openclaw/pulse-mesh.json
  // ---------------------------------------------------------------------------

  /**
   * Load (or create default) pulse-mesh.json.
   *
   * @param {string} [configPath]  Override path (for testing)
   * @returns {Promise<object>}    Parsed config object
   */
  static async loadConfig(configPath = DEFAULT_CONFIG_PATH) {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // First run — create a default config
        console.log(`[mesh] No pulse-mesh.json found at ${configPath} — creating default`);
        const defaultCfg = {
          ...DEFAULT_MESH_CONFIG,
          nodeId: process.env.PULSE_AGENT_NAME || 'hub',
          _comment: 'Edit peers[] to configure your mesh. See DPWP spec for details.',
        };
        try {
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, JSON.stringify(defaultCfg, null, 2));
        } catch (writeErr) {
          console.warn(`[mesh] Could not write default config: ${writeErr.message}`);
        }
        return defaultCfg;
      }
      // JSON parse error or other read error
      console.error(`[mesh] Failed to load pulse-mesh.json: ${err.message}`);
      return DEFAULT_MESH_CONFIG;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to all configured peers and start ping loop.
   */
  async connectAll() {
    if (this.peers.size === 0) {
      console.log('[mesh] No peers configured — running in standalone mode');
      return;
    }

    console.log(`[mesh] Connecting to ${this.peers.size} configured peer(s)...`);
    for (const peer of this.peers.values()) {
      this._connect(peer);
    }

    this._startPingLoop();
  }

  /**
   * Gracefully close all peer connections and stop ping loop.
   */
  shutdown() {
    this._shuttingDown = true;

    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }

    for (const peer of this.peers.values()) {
      this._clearPeerTimers(peer);
      if (peer.ws) {
        try { peer.ws.close(); } catch {}
        peer.ws = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Peer accessors
  // ---------------------------------------------------------------------------

  /**
   * Get a peer entry by node ID (regardless of status).
   *
   * @param {string} nodeId
   * @returns {object|null}
   */
  getPeer(nodeId) {
    return this.peers.get(nodeId) || null;
  }

  /**
   * Get all peers currently in ALIVE state.
   *
   * @returns {object[]}
   */
  getAlivePeers() {
    return Array.from(this.peers.values()).filter(p => p.status === PeerState.ALIVE);
  }

  /**
   * Called by MeshRouter when a peer reconnects — triggers store-forward flush.
   * @param {string} nodeId
   */
  onPeerReconnected(nodeId) {
    this.onReconnected(nodeId);
  }

  // ---------------------------------------------------------------------------
  // Connection establishment
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _initPeerEntry(peerConf) {
    const entry = {
      nodeId:       peerConf.nodeId,
      ip:           peerConf.ip,
      port:         peerConf.port || 18800,
      priority:     peerConf.priority ?? 1,
      status:       PeerState.UNVERIFIED,
      ws:           null,
      latencyMs:    null,
      missedPings:  0,
      pingSeq:      0,
      pingAt:       null,
      pingTimer:    null,
      reconnTimer:  null,
      backoffMs:    this.cfg.reconnect?.initialDelayMs || 1000,
      connectedAt:  null,
    };
    this.peers.set(peerConf.nodeId, entry);
    return entry;
  }

  /**
   * Open a WebSocket connection to a peer.
   * @param {object} peer
   * @private
   */
  _connect(peer) {
    if (this._shuttingDown) return;

    const url = `ws://${peer.ip}:${peer.port}`;
    let ws;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error(`[mesh] Failed to create WS for mesh peer ${peer.nodeId}: ${err.message}`);
      this._scheduleReconnect(peer);
      return;
    }

    peer.ws = ws;

    ws.on('open', () => {
      // FIRST: Send the legacy identify handshake (required by hub.js WS server)
      // Without this, the hub's 5-second auth timeout kills the connection.
      const identifyToken = peer.token || this.cfg.peerToken || 'change-me-token';
      try {
        ws.send(JSON.stringify({
          type:  'identify',
          agent: this.nodeId,
          token: identifyToken,
        }));
      } catch {}

      // THEN: Send a peer-announce to advertise mesh capabilities
      const announce = {
        protocol:  'pulse/2.0',
        messageId: this._newId(),
        type:      'peer-announce',
        from:      this.nodeId,
        to:        peer.nodeId,
        ttl:       1,
        path:      [],
        timestamp: Date.now(),
        payload: {
          nodeId:  this.nodeId,
          port:    this.cfg.listenPort || 18800,
          version: '1.0.0',
          peers:   Array.from(this.peers.keys()),
          publicKey: this.cfg.publicKeyB64 || null,
        },
      };
      try { ws.send(JSON.stringify(announce)); } catch {}

      console.log(`[mesh:peer-connected] nodeId=${peer.nodeId} ip=${peer.ip} port=${peer.port}`);
      // Status moves to ALIVE on first successful pong exchange,
      // but we treat open as tentatively alive so routing can start.
      // If pong never comes, ping loop will mark dead within ~40s.
      peer.status     = PeerState.ALIVE;
      peer.connectedAt = Date.now();
      peer.backoffMs  = this.cfg.reconnect?.initialDelayMs || 1000;
      peer.missedPings = 0;

      this.onConnected(peer.nodeId);
    });

    ws.on('message', (rawData) => {
      let envelope;
      try {
        envelope = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      // Handle pong at manager level — don't bubble to router
      if (envelope.type === 'pong' && envelope.protocol === 'pulse/2.0') {
        this._handlePong(peer, envelope);
        return;
      }

      // Forward all other pulse/2.0 messages up to the hub
      if (envelope.protocol === 'pulse/2.0') {
        this.onMessage(envelope, peer.nodeId);
      }
      // pulse/1.0 messages on a mesh connection are unexpected — log and ignore
    });

    ws.on('pong', () => {
      // WebSocket-level pong (from ws.ping()) — used by existing hub heartbeat
      if (peer.pingAt) {
        peer.latencyMs = Date.now() - peer.pingAt;
        peer.pingAt    = null;
      }
    });

    ws.on('close', () => {
      if (peer.status !== PeerState.DEAD) {
        peer.status = PeerState.DEAD;
        if (!this._shuttingDown) {
          console.log(`[mesh:peer-disconnected] nodeId=${peer.nodeId} status=dead`);
          this.onDisconnected(peer.nodeId);
        }
      }
      peer.ws          = null;
      peer.connectedAt = null;
      this._clearPingTimer(peer);
      if (!this._shuttingDown) {
        this._scheduleReconnect(peer);
      }
    });

    ws.on('error', (err) => {
      // 'close' fires after 'error' — reconnect is handled there
      console.error(`[mesh] Peer WS error (${peer.nodeId}): ${err.message}`);
      peer.status = PeerState.DEAD;
    });
  }

  // ---------------------------------------------------------------------------
  // Ping/pong keepalive
  // ---------------------------------------------------------------------------

  /**
   * Start the ping loop — fires every pingIntervalMs for all alive peers.
   * @private
   */
  _startPingLoop() {
    const intervalMs = this.cfg.pingIntervalMs || 30000;

    this._pingInterval = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (peer.ws?.readyState === WebSocket.OPEN) {
          this._sendPing(peer);
        }
      }

      // Check minimum relay nodes
      const aliveCount = this.getAlivePeers().length;
      if (this.peers.size > 0 && aliveCount < (this.cfg.minRelayNodes || 2)) {
        console.warn(`[mesh] WARN: below minimum relay threshold (alive=${aliveCount} min=${this.cfg.minRelayNodes || 2}) — forcing reconnect`);
        // Force reconnect to all dead peers, bypassing backoff
        for (const peer of this.peers.values()) {
          if (peer.status === PeerState.DEAD && !peer.reconnTimer) {
            this._connect(peer);
          }
        }
      }
    }, intervalMs);
  }

  /**
   * Send a pulse/2.0 ping envelope to a peer.
   * @param {object} peer
   * @private
   */
  _sendPing(peer) {
    const timeoutMs = this.cfg.pingTimeoutMs || 10000;
    const seq = ++peer.pingSeq;

    const pingEnvelope = {
      protocol:  'pulse/2.0',
      messageId: this._newId(),
      type:      'ping',
      from:      this.nodeId,
      to:        peer.nodeId,
      ttl:       1,
      path:      [this.nodeId],
      timestamp: Date.now(),
      payload:   { seq },
    };

    peer.pingAt = Date.now();

    try {
      peer.ws.send(JSON.stringify(pingEnvelope));
    } catch (err) {
      console.error(`[mesh] Ping send failed for ${peer.nodeId}: ${err.message}`);
      return;
    }

    // Set timeout — if pong doesn't arrive in time, increment missedPings
    peer.pingTimer = setTimeout(() => {
      peer.pingTimer = null;
      peer.missedPings++;
      peer.pingAt = null;

      console.warn(`[mesh] Pong timeout from ${peer.nodeId} (missed=${peer.missedPings})`);

      if (peer.missedPings >= (this.cfg.deadThresholdMisses || 3)) {
        console.log(`[mesh:peer-dead] nodeId=${peer.nodeId} missedPings=${peer.missedPings}`);
        peer.status = PeerState.DEAD;
        if (peer.ws) {
          try { peer.ws.close(); } catch {}
          peer.ws = null;
        }
        this.onDisconnected(peer.nodeId);
        this._scheduleReconnect(peer);
      }
    }, timeoutMs);
  }

  /**
   * Handle an incoming pong envelope.
   * @param {object} peer
   * @param {object} envelope
   * @private
   */
  _handlePong(peer, envelope) {
    this._clearPingTimer(peer);
    peer.missedPings = 0;
    peer.latencyMs   = Date.now() - (peer.pingAt || Date.now());
    peer.pingAt      = null;

    const wasDeadOrUnverified = peer.status !== PeerState.ALIVE;
    peer.status = PeerState.ALIVE;

    if (wasDeadOrUnverified) {
      console.log(`[mesh:peer-reconnected] nodeId=${peer.nodeId} latencyMs=${peer.latencyMs}`);
      this.onPeerReconnected(peer.nodeId);
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnect with exponential backoff
  // ---------------------------------------------------------------------------

  /**
   * Schedule a reconnect attempt after exponential backoff.
   * @param {object} peer
   * @private
   */
  _scheduleReconnect(peer) {
    if (this._shuttingDown) return;
    if (peer.reconnTimer) return; // already scheduled

    const maxDelay = this.cfg.reconnect?.maxDelayMs || 60000;
    const delay    = Math.min(peer.backoffMs, maxDelay);

    console.log(`[mesh] Reconnecting to ${peer.nodeId} in ${delay}ms`);

    peer.reconnTimer = setTimeout(() => {
      peer.reconnTimer = null;
      // Increase backoff for next failure
      const mult = this.cfg.reconnect?.multiplier || 2;
      peer.backoffMs = Math.min(peer.backoffMs * mult, maxDelay);
      this._connect(peer);
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  _clearPingTimer(peer) {
    if (peer.pingTimer) {
      clearTimeout(peer.pingTimer);
      peer.pingTimer = null;
    }
  }

  _clearPeerTimers(peer) {
    this._clearPingTimer(peer);
    if (peer.reconnTimer) {
      clearTimeout(peer.reconnTimer);
      peer.reconnTimer = null;
    }
  }

  /** Generate a short unique ID for ping/pong/announce messages */
  _newId() {
    return `${this.nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
