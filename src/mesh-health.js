/**
 * mesh-health.js — GET /mesh/health HTTP endpoint handler
 *
 * Returns the node's mesh status: peer states, seenSet size, queue size,
 * uptime, and routing stats.
 *
 * Spec ref: DPWP/1.0 Section 12.2 — Health Endpoint
 *
 * Response format:
 * {
 *   "nodeId": "my-agent",
 *   "status": "healthy",
 *   "peers": {
 *     "alive":      ["agent-d", "agent-a"],
 *     "dead":       ["agent-c"],
 *     "unverified": []
 *   },
 *   "seenSetSize": 423,
 *   "queueSize":   0,
 *   "uptime":      86400,
 *   "messagesRouted":  12847,
 *   "messagesDropped": 3,
 *   "messagesRelayed": 12800,
 *   "messagesQueued":  44
 * }
 *
 * Status is "healthy" if ≥2 peers alive, "degraded" if 1, "isolated" if 0.
 *
 * Usage (called in hub.js _handleApiRequest):
 *   import { handleMeshHealth } from './mesh-health.js';
 *   handleMeshHealth(req, res, { peerManager, seenSet, sfQueue, meshRouter, startTime });
 */

import { PeerState } from './peer-manager.js';

/**
 * Handle GET /mesh/health request.
 *
 * @param {object} req          Node.js IncomingMessage
 * @param {object} res          Node.js ServerResponse
 * @param {object} components   Mesh component refs
 * @param {object} components.nodeId        This node's ID
 * @param {object} components.peerManager   PeerManager instance
 * @param {object} components.seenSet       SeenSet instance
 * @param {object} components.sfQueue       StoreForwardQueue instance
 * @param {object} components.meshRouter    MeshRouter instance
 * @param {number} components.startTime     process.hrtime() or Date.now() at start
 */
export function handleMeshHealth(req, res, components) {
  const { nodeId, peerManager, seenSet, sfQueue, meshRouter, startTime } = components;

  const peers = { alive: [], dead: [], unverified: [] };

  if (peerManager) {
    for (const peer of peerManager.peers.values()) {
      switch (peer.status) {
        case PeerState.ALIVE:      peers.alive.push(peer.nodeId);      break;
        case PeerState.DEAD:       peers.dead.push(peer.nodeId);       break;
        case PeerState.UNVERIFIED: peers.unverified.push(peer.nodeId); break;
        default:                   peers.unverified.push(peer.nodeId); break;
      }
    }
  }

  const aliveCount = peers.alive.length;
  const status = aliveCount >= 2 ? 'healthy'
               : aliveCount === 1 ? 'degraded'
               : 'isolated';

  const uptimeMs = startTime ? (Date.now() - startTime) : (process.uptime() * 1000);

  const health = {
    nodeId:           nodeId || 'unknown',
    status,
    peers,
    seenSetSize:      seenSet  ? seenSet.size  : 0,
    queueSize:        sfQueue  ? sfQueue.size  : 0,
    uptime:           Math.floor(uptimeMs / 1000),
    messagesRouted:   meshRouter ? meshRouter.stats.messagesRouted  : 0,
    messagesRelayed:  meshRouter ? meshRouter.stats.messagesRelayed : 0,
    messagesDropped:  meshRouter ? meshRouter.stats.messagesDropped : 0,
    messagesQueued:   meshRouter ? meshRouter.stats.messagesQueued  : 0,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health, null, 2));
}
