#!/usr/bin/env node

// ── PulseNet-to-Gateway Bridge Config ─────────────────────────────────────────
const GATEWAY_HOOK_URL = process.env.GATEWAY_HOOK_URL || 'http://127.0.0.1:18789/hooks/pulsenet';
const GATEWAY_HOOK_TOKEN = process.env.GATEWAY_HOOK_TOKEN || process.env.PULSE_HOOK_TOKEN || '';

async function forwardToGateway(msg, agentName) {
  // Only forward actual messages, not control signals
  if (!msg || (msg.type !== 'message' && msg.type !== 'request')) return;

  // Don't forward our own outbound messages back to ourselves
  if (msg.from === agentName) return;

  const payload = msg.payload || {};
  const body = payload.body || '';
  const conversationId = payload.conversationId || msg.conversationId || 'unknown';
  const sender = payload.sender || msg.from || 'unknown';

  if (!body.trim()) return;

  // Inject reply instructions so the agent knows how to respond back to PulseNet
  const replyInstructions = process.env.PULSE_REPLY_TEMPLATE ? `\n\n${process.env.PULSE_REPLY_TEMPLATE.replace(/{CONV_ID}/g, conversationId)}` : "";
  
  const hookPayload = {
    message: body + replyInstructions,
    sessionKey: `hook:pulse:${conversationId}`,
    sender: sender,
    conversationId: conversationId,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (GATEWAY_HOOK_TOKEN) {
    headers['Authorization'] = `Bearer ${GATEWAY_HOOK_TOKEN}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(GATEWAY_HOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(hookPayload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log(`[pulse-bridge] Forwarded to gateway: ${res.status} (conv=${conversationId}, from=${sender}, len=${body.length})`);
    
    // If gateway returns a response body, send it back through pulse
    if (res.ok) {
      try {
        const resText = await res.text();
        const trimmed = resText.trim();
        // Filter out gateway ack responses ({"ok":true}, {"ok":true,"runId":"..."}, etc.)
        if (trimmed && trimmed !== 'OK') {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && parsed.ok === true && Object.keys(parsed).every(k => ['ok','runId','id','sessionKey'].includes(k))) {
              return null; // Gateway ack — suppress
            }
          } catch {}
          return trimmed;
        }
      } catch {}
    }
  } catch (err) {
    console.warn(`[pulse-bridge] Gateway forward failed: ${err.message}`);
  }
  return null;
}
// ── End PulseNet-to-Gateway Bridge ────────────────────────────────────────────


/**
 * agent-pulse hub - Real-time WebSocket messaging hub for AI agent fleets
 *
 * Each agent runs one instance of this process. It:
 *   - Accepts inbound WebSocket connections from peers (port 18800)
 *   - Dials outbound WebSocket connections to all known peers
 *   - Routes messages between peers, with HTTP POST as fallback
 *   - Maintains conversation state on disk
 *   - Exposes a REST API for CLI tools and local integrations (port 18801)
 *   - Emits an SSE stream of incoming messages for dashboards / bridges
 */

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createReadStream, promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Mesh imports (DPWP/1.0 Phase 1) ───────────────────────────────────────
import { SeenSet }          from './seen-set.js';
import { StoreForwardQueue } from './store-forward.js';
import { MeshRouter }       from './mesh-router.js';
import { PeerManager }      from './peer-manager.js';
import { handleMeshHealth } from './mesh-health.js';
import { EnvelopeCrypto } from './envelope-crypto.js';
// ── End mesh imports ───────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const REGISTRY_PATH = process.env.PULSE_REGISTRY || path.join(ROOT, 'config', 'agent-registry.json');

// ---------------------------------------------------------------------------
// Configuration loader
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Return a minimal default so the hub can start without a config file.
    // Useful for testing where we pass env vars directly.
    return {
      agent: process.env.PULSE_AGENT_NAME || 'hub',
      port:  parseInt(process.env.PULSE_WS_PORT  || '18800', 10),
      apiPort: parseInt(process.env.PULSE_API_PORT || '18801', 10),
      peers: {},
      groups: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Filesystem helper
// ---------------------------------------------------------------------------

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// Hub class
// ---------------------------------------------------------------------------

export class Hub extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.agentName = config.agent;
    this.wsPort    = config.port    || 18800;
    this.apiPort   = config.apiPort || 18801;

    // Per-instance paths so multiple hubs can coexist in the same process (tests).
    this.auditLogPath    = config.auditLogPath    || process.env.PULSE_AUDIT_LOG || path.join(ROOT, 'logs', 'pulse-audit.jsonl');
    this.conversationsDir = config.conversationsDir || process.env.PULSE_CONV_DIR  || path.join(ROOT, 'state', 'conversations');

    // peer name -> { ip, port, token }  (from registry)
    this.peerRegistry = config.peers || {};

    // peer name -> WebSocket (inbound accepted connections)
    this.inboundPeers = new Map();

    // peer name -> { ws, status, reconnectTimer, backoffMs, connectedAt, latencyMs, pingAt }
    this.outboundPeers = new Map();

    // SSE response objects waiting for events
    this.sseClients = new Set();

    this.wss     = null;  // WebSocketServer
    this.httpApi = null;  // HTTP server for REST API

    this._shuttingDown = false;

    // ── Mesh components (DPWP/1.0) — initialised in start() ──────────────────
    this.meshConfig    = null;   // loaded pulse-mesh.json
    this.seenSet       = null;   // SeenSet (dedup ring buffer)
    this.sfQueue       = null;   // StoreForwardQueue (retry buffer)
    this.meshRouter    = null;   // MeshRouter (routing logic)
    this.meshPeerMgr   = null;   // PeerManager (peer connections)
    this._meshStartTime = null;  // for uptime reporting
    this._sfqPurgeTimer = null;  // periodic expired-message cleanup
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  async start() {
    await ensureDir(path.dirname(this.auditLogPath));
    await ensureDir(this.conversationsDir);

    // ── Initialise mesh components (Phase 1) ───────────────────────────────
    await this._initMesh();

    this._startWsServer();
    this._startApiServer();
    this._dialAllPeers();
    this._startHeartbeat();

    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT',  () => this.shutdown());
  }

  // -------------------------------------------------------------------------
  // Mesh initialisation
  // -------------------------------------------------------------------------

  async _initMesh() {
    // Load config — creates default if missing
    this.meshConfig = await PeerManager.loadConfig();

    // Override nodeId from mesh config if set, else use agentName
    const nodeId = this.meshConfig.nodeId || this.agentName;
    this._meshStartTime = Date.now();

    // SeenSet — deduplication ring buffer
    this.seenSet = new SeenSet(
      this.meshConfig.seenSet?.maxSize      || this.meshConfig.seenSetMaxSize      || 10000,
      this.meshConfig.seenSet?.ttlMs        || this.meshConfig.seenSetTtlMs        || 14_400_000,
    );

    // EnvelopeCrypto — E2E encryption (Meshtastic-style blind relay)
    this.envelopeCrypto = new EnvelopeCrypto(this.agentName);
    await this.envelopeCrypto.init();

    // PeerManager — mesh peer connections
    this.meshPeerMgr = new PeerManager({
      nodeId,
      meshConfig: { ...this.meshConfig, publicKeyB64: this.envelopeCrypto.getPublicKeyB64() },
      onMessage: (envelope, peerId) => {
        // Incoming pulse/2.0 from a mesh peer
        // Register peer public key from peer-announce
        if (envelope.type === 'peer-announce' && envelope.payload?.publicKey) {
          this.envelopeCrypto.registerPeerKey(envelope.from, envelope.payload.publicKey);
        }
        // Decrypt if we're a recipient
        if (EnvelopeCrypto.isEncrypted(envelope) && this.envelopeCrypto.canDecrypt(envelope.encrypted)) {
          const payload = this.envelopeCrypto.decrypt(envelope.encrypted);
          if (payload) {
            envelope._decrypted = payload;
          }
        }
        this.meshRouter.route(envelope);
      },
      onReconnected: (peerId) => {
        console.log(`[mesh:peer-reconnected] nodeId=${peerId}`);
        // Flush any queued messages destined for this peer
        if (this.sfQueue) this.sfQueue.flushFor(peerId);
      },
      onConnected:    (peerId) => this.emit('mesh:peer:connected',    { peer: peerId }),
      onDisconnected: (peerId) => this.emit('mesh:peer:disconnected', { peer: peerId }),
    });

    // StoreForwardQueue — buffer undeliverable messages; needs route() reference
    // We pass a thunk so it can call meshRouter.route() once router is created
    this.sfQueue = new StoreForwardQueue({
      route:          (envelope) => this.meshRouter.route(envelope),
      sendRouteError: (envelope, reason) => this._meshSendRouteError(envelope, reason),
      maxSize: this.meshConfig.storeForward?.maxQueue || this.meshConfig.storeForwardMaxQueue || 100,
      ttlMs:   this.meshConfig.storeForward?.ttlMs    || this.meshConfig.storeForwardTtlMs    || 3_600_000,
    });

    // MeshRouter — core routing logic
    this.meshRouter = new MeshRouter({
      nodeId,
      seenSet:     this.seenSet,
      peerManager: this.meshPeerMgr,
      sfQueue:     this.sfQueue,
      ttlDefault:     this.meshConfig.ttlDefault || 3,
      envelopeCrypto: this.envelopeCrypto,
      onDeliver:   (envelope) => this._handleMeshDelivery(envelope),
    });

    // Connect to configured peers
    await this.meshPeerMgr.connectAll();

    // Periodic store-forward queue purge (every minute)
    this._sfqPurgeTimer = setInterval(() => {
      this.sfQueue.purgeExpired();
    }, 60_000);

    console.log(`[mesh] Phase 1 mesh initialised — nodeId=${nodeId} peers=${this.meshConfig.peers?.length || 0}`);
  }

  /**
   * Handle a pulse/2.0 envelope that was delivered to THIS node.
   * Called by MeshRouter.onDeliver().
   *
   * @param {object} envelope  pulse/2.0 envelope
   */
  async _handleMeshDelivery(envelope) {
    const { type, from, to, payload = {}, messageId } = envelope;

    // Emit on local bus for in-process subscribers
    this.emit('mesh:message', envelope);

    // Push to SSE clients (alongside pulse/1.0 messages)
    const ssePayload = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const sseRes of this.sseClients) {
      try { sseRes.write(ssePayload); } catch { /* ignore */ }
    }

    // Handle control message types internally
    if (type === 'ping') {
      // Respond with pong via mesh
      this.meshRouter.originate({
        to:      from,
        type:    'pong',
        payload: { seq: payload.seq, respondedAt: Date.now() },
        replyTo: messageId,
      });
      return;
    }

    if (type === 'pong') {
      // Pong may arrive via inbound WS (not the outbound connection where
      // peer-manager listens). Forward it to peer-manager explicitly.
      if (this.meshPeerMgr) {
        const peer = this.meshPeerMgr.getPeer(from);
        if (peer) {
          this.meshPeerMgr._handlePong(peer, envelope);
        }
      }
      return;
    }

    if (type === 'route-error') {
      console.warn(`[mesh:route-error] messageId=${payload.failedMessageId} reason=${payload.reason} path=${JSON.stringify(payload.attemptedPath)}`);
      return;
    }

    if (type === 'peer-announce') {
      // Log peer announcement — gossip extension point for Phase 2+
      console.log(`[mesh] peer-announce from ${from}: peers=${JSON.stringify(payload.peers)}`);
      return;
    }

    if (type === 'ack') {
      console.log(`[mesh] ack for ${payload.ackedMessageId} from ${from}`);
      return;
    }

    // Encrypted messages: unwrap and process as application message
    if (type === 'encrypted') {
      if (!envelope._decrypted) {
        console.log(`[mesh:encrypted] Not a recipient — dropping ${messageId} from ${from}`);
        return;
      }
      console.log(`[mesh:encrypted] Decrypted message ${messageId} from ${from}`);
      const decryptedPayload = envelope._decrypted;
      const legacyMsg = {
        protocol:       'pulse/1.0',
        id:             messageId,
        conversationId: decryptedPayload.conversationId || decryptedPayload.channel,
        from,
        to:             this.agentName,
        type:           'message',
        timestamp:      new Date(envelope.timestamp).toISOString(),
        payload:        decryptedPayload,
      };
      if (decryptedPayload.conversationId) {
        await this._appendToConversation(legacyMsg);
      }
      const gatewayResponse = await forwardToGateway(legacyMsg, this.agentName);
      if (gatewayResponse && from) {
        const convId = decryptedPayload.conversationId || decryptedPayload.channel;
        const replyPayload = { body: gatewayResponse, conversationId: convId, sender: this.agentName };
        // Reply will be auto-encrypted by mesh-router originate()
        this.meshRouter.originate({ to: from, type: 'message', payload: replyPayload });
      }
      return;
    }

    // Application messages: forward to OpenClaw gateway (same as pulse/1.0 path)
    if (type === 'message' || type === 'request') {
      // Convert to pulse/1.0-like structure for forwardToGateway
      const legacyMsg = {
        protocol:       'pulse/1.0',
        id:             messageId,
        conversationId: payload.conversationId || payload.channel,
        from,
        to,
        type,
        timestamp:      new Date(envelope.timestamp).toISOString(),
        payload,
      };

      if (payload.conversationId) {
        await this._appendToConversation(legacyMsg);
      }

      await this._auditLog({
        id:             messageId,
        from,
        to,
        type,
        protocol:       'pulse/2.0',
        status:         'received',
        latencyMs:      Date.now() - envelope.timestamp,
      });

      const gatewayResponse = await forwardToGateway(legacyMsg, this.agentName);
      if (gatewayResponse) {
        const convId = payload.conversationId || payload.channel;
        if (from && from !== this.agentName) {
          this.meshRouter.originate({
            to:      from,
            type:    'message',
            payload: {
              body:           gatewayResponse,
              conversationId: convId,
              sender:         this.agentName,
            },
          });
        }
      }
    }
  }

  /**
   * Send a route-error for an undeliverable envelope (used by StoreForwardQueue).
   * @param {object} envelope  Original failed envelope
   * @param {string} reason    Error reason string
   */
  _meshSendRouteError(envelope, reason) {
    if (!this.meshRouter || envelope.from === (this.meshConfig?.nodeId || this.agentName)) return;
    this.meshRouter.originate({
      to:      envelope.from,
      type:    'route-error',
      payload: {
        failedMessageId: envelope.messageId,
        reason,
        attemptedPath:   envelope.path || [],
      },
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket server (inbound connections from peers)
  // -------------------------------------------------------------------------

  _startWsServer() {
    this.wss = new WebSocketServer({ port: this.wsPort });

    this.wss.on('connection', (ws, req) => {
      const remoteAddr = req.socket.remoteAddress;
      let peerName = null;

      // Set a short timeout: peers must identify themselves within 5 seconds.
      const authTimeout = setTimeout(() => {
        if (!peerName) {
          ws.close(4001, 'Authentication timeout');
        }
      }, 5000);

      ws.on('message', async (rawData) => {
        let msg;
        try {
          msg = JSON.parse(rawData.toString());
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }

        // --- Identity handshake ---
        if (msg.type === 'identify') {
          const { agent, token } = msg;
          const peer = this.peerRegistry[agent];
          if (!peer || peer.token !== token) {
            ws.close(4003, 'Unauthorized');
            return;
          }
          clearTimeout(authTimeout);
          peerName = agent;
          this.inboundPeers.set(peerName, ws);
          this.emit('peer:connected', { peer: peerName, direction: 'inbound' });
          ws.send(JSON.stringify({ type: 'identified', agent: this.agentName }));
          return;
        }

        // All other messages require a completed handshake.
        if (!peerName) {
          ws.close(4001, 'Not identified');
          return;
        }

        await this._handleIncomingMessage(msg, peerName);
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        if (peerName) {
          this.inboundPeers.delete(peerName);
          this.emit('peer:disconnected', { peer: peerName, direction: 'inbound' });
        }
      });

      ws.on('error', (err) => {
        // Log but do not crash.
        console.error(`[pulse] WS error from ${remoteAddr}:`, err.message);
      });

      ws.on('pong', () => {
        // Record pong arrival for inbound peers (latency tracked on outbound side).
      });
    });

    this.wss.on('error', (err) => {
      console.error('[pulse] WS server error:', err.message);
    });

    console.log(`[pulse] WS server listening on port ${this.wsPort} (agent: ${this.agentName})`);
  }

  // -------------------------------------------------------------------------
  // Outbound WebSocket connections to peers
  // -------------------------------------------------------------------------

  _dialAllPeers() {
    for (const [peerName, peerConf] of Object.entries(this.peerRegistry)) {
      this._dialPeer(peerName, peerConf);
    }
  }

  _dialPeer(peerName, peerConf) {
    if (this._shuttingDown) return;

    const state = this.outboundPeers.get(peerName) || {
      ws: null,
      status: 'connecting',
      reconnectTimer: null,
      backoffMs: 1000,
      connectedAt: null,
      latencyMs: null,
      pingAt: null,
    };
    this.outboundPeers.set(peerName, state);

    const url = peerConf.url || `ws://${peerConf.ip || peerConf.host}:${peerConf.port || 18800}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error(`[pulse] Failed to create WS for ${peerName}: ${err.message}`);
      this._scheduleReconnect(peerName, peerConf);
      return;
    }

    state.ws     = ws;
    state.status = 'connecting';

    ws.on('open', () => {
      // Reset backoff on successful connection.
      state.backoffMs    = 1000;
      state.connectedAt  = new Date().toISOString();
      state.status       = 'connected';

      // Send identity.
      ws.send(JSON.stringify({
        type:  'identify',
        agent: this.agentName,
        token: peerConf.token,
      }));

      this.emit('peer:connected', { peer: peerName, direction: 'outbound' });
      console.log(`[pulse] Connected to peer: ${peerName} (${url})`);
    });

    ws.on('message', async (rawData) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      // Skip the identity acknowledgement (already handled by open).
      if (msg.type === 'identified') return;

      await this._handleIncomingMessage(msg, peerName);
    });

    ws.on('pong', () => {
      if (state.pingAt) {
        state.latencyMs = Date.now() - state.pingAt;
        state.pingAt    = null;
      }
    });

    ws.on('close', () => {
      state.status      = 'disconnected';
      state.ws          = null;
      state.connectedAt = null;
      this.emit('peer:disconnected', { peer: peerName, direction: 'outbound' });
      console.log(`[pulse] Disconnected from peer: ${peerName}`);
      this._scheduleReconnect(peerName, peerConf);
    });

    ws.on('error', (err) => {
      // The 'close' event fires after 'error', so reconnect is handled there.
      state.status = 'error';
      console.error(`[pulse] Outbound WS error (${peerName}): ${err.message}`);
    });
  }

  _scheduleReconnect(peerName, peerConf) {
    if (this._shuttingDown) return;

    const state = this.outboundPeers.get(peerName);
    if (!state) return;

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
    }

    const delay = Math.min(state.backoffMs, 30000);
    console.log(`[pulse] Reconnecting to ${peerName} in ${delay}ms`);

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.backoffMs = Math.min(state.backoffMs * 2, 30000);
      this._dialPeer(peerName, peerConf);
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Heartbeat (ping all outbound connections every 30s)
  // -------------------------------------------------------------------------

  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      for (const [peerName, state] of this.outboundPeers.entries()) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.pingAt = Date.now();
          state.ws.ping();
        }
      }
    }, 30000);
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  async _handleIncomingMessage(msg, fromPeer) {
    // ── Protocol dispatch ────────────────────────────────────────────────────
    // pulse/2.0 messages are routed through the mesh subsystem
    if (msg.protocol === 'pulse/2.0') {
      // Register peer public key from any peer-announce (inbound or outbound)
      if (msg.type === 'peer-announce' && msg.payload?.publicKey && this.envelopeCrypto) {
        this.envelopeCrypto.registerPeerKey(msg.from, msg.payload.publicKey);
      }
      // Decrypt if we're a recipient
      if (this.envelopeCrypto && EnvelopeCrypto.isEncrypted(msg) && this.envelopeCrypto.canDecrypt(msg.encrypted)) {
        const payload = this.envelopeCrypto.decrypt(msg.encrypted);
        if (payload) {
          msg._decrypted = payload;
        }
      }
      if (this.meshRouter) {
        this.meshRouter.route(msg);
      } else {
        console.warn(`[pulse] Received pulse/2.0 message but mesh not initialised — dropping`);
      }
      return;
    }

    // Validate envelope shape for pulse/1.0 (backward compat).
    if (!msg.protocol || msg.protocol !== 'pulse/1.0') {
      console.warn(`[pulse] Ignoring message with unknown protocol from ${fromPeer}`);
      return;
    }

    const receivedAt = Date.now();

    // Update conversation state.
    if (msg.conversationId) {
      await this._appendToConversation(msg);
    }

    // Emit on local bus for in-process subscribers (CLI, SSE).
    this.emit('message', msg);

    // Push to SSE clients.
    const ssePayload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(ssePayload); } catch { /* ignore broken pipes */ }
    }

    // Audit log.
    const latencyMs = msg.timestamp
      ? receivedAt - new Date(msg.timestamp).getTime()
      : null;

    await this._auditLog({
      id:             msg.id,
      from:           msg.from,
      to:             msg.to,
      type:           msg.type,
      conversationId: msg.conversationId || null,
      status:         'received',
      latencyMs,
    });

    // Forward to local OpenClaw gateway via hook
    const gatewayResponse = await forwardToGateway(msg, this.agentName);
    if (gatewayResponse) {
      // Send response back through pulse to PulseNet
      const convId = msg.payload?.conversationId || msg.conversationId;
      if (convId && msg.from) {
        await this.send(msg.from, 'message', { 
          body: gatewayResponse, 
          conversationId: convId,
          sender: this.agentName,
        }, { conversationId: convId });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sending messages
  // -------------------------------------------------------------------------

  async send(to, type, payload, opts = {}) {
    const convId = opts.conversationId || `conv_${uuidv4()}`;

    // Attach conversation context so receivers have full round history.
    let conversationContext = null;
    if (opts.conversationId) {
      const existing = await this._loadConversation(opts.conversationId);
      if (existing && existing.rounds && existing.rounds.length > 0) {
        conversationContext = {
          conversationId: existing.conversationId,
          status:         existing.status,
          participants:   existing.participants,
          rounds:         existing.rounds,
        };
      }
    }

    const msg = {
      protocol:       'pulse/1.0',
      id:             `msg_${uuidv4()}`,
      conversationId: convId,
      from:           this.agentName,
      to,
      type,
      timestamp:      new Date().toISOString(),
      payload,
      ...(conversationContext ? { conversationContext } : {}),
    };

    // Record outbound message in local conversation state.
    await this._appendToConversation(msg);

    if (to === '*') {
      return this._broadcast(msg);
    }

    const delivered = await this._routeMessage(to, msg);

    await this._auditLog({
      id:             msg.id,
      from:           msg.from,
      to:             msg.to,
      type:           msg.type,
      conversationId: msg.conversationId,
      status:         delivered ? 'delivered' : 'fallback',
      latencyMs:      null,
    });

    return { messageId: msg.id, conversationId: convId, delivered, msg };
  }

  async _broadcast(msg) {
    const results = {};

    for (const peerName of Object.keys(this.peerRegistry)) {
      const m = { ...msg, to: peerName };
      results[peerName] = await this._routeMessage(peerName, m);
    }

    await this._auditLog({
      id:             msg.id,
      from:           msg.from,
      to:             '*',
      type:           msg.type,
      conversationId: msg.conversationId,
      status:         'broadcast',
      latencyMs:      null,
    });

    return { messageId: msg.id, conversationId: msg.conversationId, results };
  }

  async _routeMessage(peerName, msg) {
    // Try outbound WS first.
    const outboundState = this.outboundPeers.get(peerName);
    if (outboundState?.ws?.readyState === WebSocket.OPEN) {
      outboundState.ws.send(JSON.stringify(msg));
      return true;
    }

    // Try inbound WS (peer connected to us).
    const inboundWs = this.inboundPeers.get(peerName);
    if (inboundWs?.readyState === WebSocket.OPEN) {
      inboundWs.send(JSON.stringify(msg));
      return true;
    }

    // HTTP fallback.
    return this._httpFallback(peerName, msg);
  }

  async _httpFallback(peerName, msg) {
    const peer = this.peerRegistry[peerName];
    if (!peer) return false;

    // HTTP POST to peer's OpenClaw hook endpoint (MESH v3 compatible).
    const url = `http://${peer.ip}:18789/hooks/${this.agentName}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${peer.token}`,
        },
        body: JSON.stringify({ body: JSON.stringify(msg) }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.error(`[pulse] HTTP fallback to ${peerName} failed: ${err.message}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Audit logger (instance method so paths are per-hub)
  // -------------------------------------------------------------------------

  async _auditLog(record) {
    await ensureDir(path.dirname(this.auditLogPath));
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
    await fs.appendFile(this.auditLogPath, line);
  }

  // -------------------------------------------------------------------------
  // Conversation state (instance methods use per-hub conversationsDir)
  // -------------------------------------------------------------------------

  async _loadConversation(convId) {
    const filePath = path.join(this.conversationsDir, `${convId}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async _saveConversation(conv) {
    await ensureDir(this.conversationsDir);
    const filePath = path.join(this.conversationsDir, `${conv.conversationId}.json`);
    await fs.writeFile(filePath, JSON.stringify(conv, null, 2));
  }

  async _listConversations() {
    try {
      await ensureDir(this.conversationsDir);
      const files = await fs.readdir(this.conversationsDir);
      const convs = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(this.conversationsDir, f), 'utf8');
          convs.push(JSON.parse(raw));
        } catch { /* skip corrupt files */ }
      }
      return convs;
    } catch {
      return [];
    }
  }

  async _appendToConversation(msg) {
    let conv = await this._loadConversation(msg.conversationId);

    if (!conv) {
      // Create new conversation record.
      const participants = new Set([msg.from]);
      if (msg.to && msg.to !== '*') participants.add(msg.to);
      participants.add(this.agentName);

      conv = {
        conversationId: msg.conversationId,
        type:           msg.type,
        participants:   [...participants],
        status:         'active',
        createdAt:      new Date().toISOString(),
        rounds:         [],
      };
    } else {
      // Auto-add new participants seen in subsequent rounds.
      const participantSet = new Set(conv.participants);
      if (msg.from) participantSet.add(msg.from);
      if (msg.to && msg.to !== '*') participantSet.add(msg.to);
      conv.participants = [...participantSet];
    }

    // Add round.
    conv.rounds.push({
      round:     conv.rounds.length + 1,
      id:        msg.id,
      from:      msg.from,
      to:        msg.to,
      type:      msg.type,
      timestamp: msg.timestamp,
      payload:   msg.payload,
    });

    conv.updatedAt = new Date().toISOString();
    await this._saveConversation(conv);
  }

  // Park a conversation (pause it, optionally until a future time).
  async parkConversation(convId, opts = {}) {
    const conv = await this._loadConversation(convId);
    if (!conv) return null;

    conv.status   = 'parked';
    conv.parkedAt = new Date().toISOString();
    if (opts.resumeAt)     conv.resumeAt     = opts.resumeAt;
    if (opts.resumeReason) conv.resumeReason = opts.resumeReason;

    conv.updatedAt = new Date().toISOString();
    await this._saveConversation(conv);
    return conv;
  }

  // Resume a parked conversation.
  async resumeConversation(convId) {
    const conv = await this._loadConversation(convId);
    if (!conv) return null;

    conv.status    = 'active';
    conv.resumedAt = new Date().toISOString();
    delete conv.parkedAt;
    delete conv.resumeAt;
    delete conv.resumeReason;

    conv.updatedAt = new Date().toISOString();
    await this._saveConversation(conv);
    return conv;
  }

  async createConversation(opts = {}) {
    const convId = opts.conversationId || `conv_${uuidv4()}`;
    const conv = {
      conversationId: convId,
      type:           opts.type        || 'request',
      participants:   opts.participants || [this.agentName],
      status:         'active',
      createdAt:      new Date().toISOString(),
      rounds:         [],
      metadata:       opts.metadata    || {},
    };
    await this._saveConversation(conv);
    return conv;
  }

  // -------------------------------------------------------------------------
  // REST API server
  // -------------------------------------------------------------------------

  _startApiServer() {
    this.httpApi = createServer((req, res) => {
      this._handleApiRequest(req, res).catch((err) => {
        console.error('[pulse] API error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });

    this.httpApi.listen(this.apiPort, '127.0.0.1', () => {
      console.log(`[pulse] REST API listening on port ${this.apiPort}`);
    });

    this.httpApi.on('error', (err) => {
      console.error('[pulse] API server error:', err.message);
    });
  }

  async _handleApiRequest(req, res) {
    const url    = new URL(req.url, `http://localhost`);
    const method = req.method.toUpperCase();

    // CORS headers for local tooling.
    res.setHeader('Access-Control-Allow-Origin', '*');

    // ---- GET /status ----
    if (method === 'GET' && url.pathname === '/status') {
      const peers = {};
      for (const [name, state] of this.outboundPeers.entries()) {
        peers[name] = {
          status:      state.status,
          latencyMs:   state.latencyMs,
          connectedAt: state.connectedAt,
          direction:   'outbound',
        };
      }
      for (const [name, ws] of this.inboundPeers.entries()) {
        if (!peers[name]) {
          peers[name] = { status: ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected', direction: 'inbound' };
        }
      }
      json(res, {
        agent:    this.agentName,
        wsPort:   this.wsPort,
        apiPort:  this.apiPort,
        uptime:   process.uptime(),
        peers,
      });
      return;
    }

    // ---- GET /peers ----
    if (method === 'GET' && url.pathname === '/peers') {
      const peers = [];
      for (const [name, state] of this.outboundPeers.entries()) {
        peers.push({
          name,
          status:      state.status,
          latencyMs:   state.latencyMs,
          connectedAt: state.connectedAt,
          direction:   'outbound',
        });
      }
      for (const [name, ws] of this.inboundPeers.entries()) {
        if (!peers.find(p => p.name === name)) {
          peers.push({
            name,
            status:    ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
            direction: 'inbound',
          });
        }
      }
      json(res, { peers });
      return;
    }

    // ---- POST /send ----
    if (method === 'POST' && url.pathname === '/send') {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const { to, type, payload, conversationId } = data;
      if (!to || !type) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: to, type' }));
        return;
      }

      const result = await this.send(to, type, payload || {}, { conversationId });
      json(res, result);
      return;
    }

    // ---- GET /events (SSE) ----
    if (method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });
      res.write('retry: 3000\n\n');

      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // ---- GET /conversations ----
    if (method === 'GET' && url.pathname === '/conversations') {
      const convs = await this._listConversations();
      json(res, { conversations: convs });
      return;
    }

    // ---- GET /conversations/<id> ----
    const convMatch = url.pathname.match(/^\/conversations\/([^/]+)$/);
    if (method === 'GET' && convMatch) {
      const convId = convMatch[1];
      const conv   = await this._loadConversation(convId);
      if (!conv) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Conversation not found' }));
        return;
      }
      json(res, conv);
      return;
    }

    // ---- POST /conversations ----
    if (method === 'POST' && url.pathname === '/conversations') {
      const body = await readBody(req);
      let opts = {};
      try { opts = JSON.parse(body); } catch { /* empty opts ok */ }

      const conv = await this.createConversation(opts);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(conv));
      return;
    }

    // ---- POST /conversations/:id/park ----
    const parkMatch = url.pathname.match(/^\/conversations\/([^/]+)\/park$/);
    if (method === 'POST' && parkMatch) {
      const convId = parkMatch[1];
      const body   = await readBody(req);
      let opts = {};
      try { opts = JSON.parse(body); } catch { /* empty opts ok */ }

      const conv = await this.parkConversation(convId, opts);
      if (!conv) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Conversation not found' }));
        return;
      }
      json(res, conv);
      return;
    }

    // ---- POST /conversations/:id/resume ----
    const resumeMatch = url.pathname.match(/^\/conversations\/([^/]+)\/resume$/);
    if (method === 'POST' && resumeMatch) {
      const convId = resumeMatch[1];
      const conv   = await this.resumeConversation(convId);
      if (!conv) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Conversation not found' }));
        return;
      }
      json(res, conv);
      return;
    }

    // ---- GET /mesh/health ----
    if (method === 'GET' && url.pathname === '/mesh/health') {
      handleMeshHealth(req, res, {
        nodeId:      this.meshConfig?.nodeId || this.agentName,
        peerManager: this.meshPeerMgr,
        seenSet:     this.seenSet,
        sfQueue:     this.sfQueue,
        meshRouter:  this.meshRouter,
        startTime:   this._meshStartTime,
      });
      return;
    }

    // ---- 404 ----
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // -------------------------------------------------------------------------
  // Status helpers
  // -------------------------------------------------------------------------

  connectedPeers() {
    const connected = [];
    for (const [name, state] of this.outboundPeers.entries()) {
      if (state.status === 'connected') connected.push(name);
    }
    for (const [name] of this.inboundPeers.entries()) {
      if (!connected.includes(name)) connected.push(name);
    }
    return connected;
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown() {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    console.log('[pulse] Shutting down...');

    // Stop heartbeat.
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);

    // Stop mesh store-forward purge timer.
    if (this._sfqPurgeTimer) clearInterval(this._sfqPurgeTimer);

    // Shutdown mesh peer manager (closes all mesh WS connections).
    if (this.meshPeerMgr) this.meshPeerMgr.shutdown();

    // Cancel pending reconnect timers.
    for (const state of this.outboundPeers.values()) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.ws) state.ws.close();
    }

    // Close inbound connections.
    for (const ws of this.inboundPeers.values()) {
      ws.close();
    }

    // Close servers.
    await new Promise((resolve) => this.wss?.close(resolve));
    await new Promise((resolve) => this.httpApi?.close(resolve));

    console.log('[pulse] Shutdown complete.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Entry point (when run directly)
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  const hub    = new Hub(config);
  await hub.start();
}
