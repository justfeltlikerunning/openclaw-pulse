#!/usr/bin/env node
/**
 * pulse - CLI for interacting with the agent-pulse hub
 *
 * Usage:
 *   pulse send <agent> <type> "<message>"
 *   pulse broadcast "<message>"
 *   pulse status
 *   pulse peers
 *   pulse conversations
 *   pulse keys generate|show|peers|trust
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const API_PORT = parseInt(process.env.PULSE_API_PORT || '18801', 10);
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

// ---------------------------------------------------------------------------
// Key management paths
// ---------------------------------------------------------------------------

const KEY_DIR          = path.join(os.homedir(), '.openclaw', 'pulse-keys');
const PRIVATE_KEY_PATH = path.join(KEY_DIR, 'x25519.pem');
const PUBLIC_KEY_PATH  = path.join(KEY_DIR, 'x25519.pub.pem');
const PEER_KEYS_PATH   = path.join(KEY_DIR, 'peer-keys.json');

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error: ${res.status} - ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Hub commands
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const data = await apiGet('/status');
  console.log(`Agent:   ${data.agent}`);
  console.log(`WS port: ${data.wsPort}`);
  console.log(`API port:${data.apiPort}`);
  console.log(`Uptime:  ${Math.round(data.uptime)}s`);
  console.log('');
  console.log('Peers:');
  const peers = data.peers || {};
  const names = Object.keys(peers);
  if (names.length === 0) {
    console.log('  (none configured)');
  } else {
    for (const name of names) {
      const p = peers[name];
      const latency = p.latencyMs != null ? `${p.latencyMs}ms` : 'n/a';
      console.log(`  ${name}: ${p.status}  latency=${latency}  dir=${p.direction}`);
    }
  }
}

async function cmdPeers() {
  const data = await apiGet('/peers');
  const peers = data.peers || [];
  if (peers.length === 0) {
    console.log('No peers configured.');
    return;
  }
  for (const p of peers) {
    const latency = p.latencyMs != null ? `${p.latencyMs}ms` : 'n/a';
    console.log(`${p.name}  status=${p.status}  latency=${latency}  dir=${p.direction}`);
  }
}

async function cmdSend(args) {
  const [, , , agentName, type, ...messageParts] = args;
  if (!agentName || !type || messageParts.length === 0) {
    console.error('Usage: pulse send <agent> <type> "<message>"');
    process.exit(1);
  }
  const message = messageParts.join(' ');
  const result = await apiPost('/send', {
    to:      agentName,
    type,
    payload: { body: message },
  });
  console.log(`Sent: ${result.messageId}`);
  console.log(`Conversation: ${result.conversationId}`);
  console.log(`Delivered: ${result.delivered}`);
}

async function cmdBroadcast(args) {
  const [, , , ...messageParts] = args;
  if (messageParts.length === 0) {
    console.error('Usage: pulse broadcast "<message>"');
    process.exit(1);
  }
  const message = messageParts.join(' ');
  const result = await apiPost('/send', {
    to:      '*',
    type:    'notification',
    payload: { body: message },
  });
  console.log(`Broadcast sent: ${result.messageId}`);
  console.log(`Results:`, result.results);
}

async function cmdConversations() {
  const data = await apiGet('/conversations');
  const convs = data.conversations || [];
  if (convs.length === 0) {
    console.log('No conversations found.');
    return;
  }
  for (const c of convs) {
    const rounds = c.rounds?.length || 0;
    console.log(`${c.conversationId}  status=${c.status}  rounds=${rounds}  created=${c.createdAt}`);
  }
}

// ---------------------------------------------------------------------------
// Key management commands (pulse keys ...)
// ---------------------------------------------------------------------------

async function ensureKeyDir() {
  await fs.mkdir(KEY_DIR, { recursive: true });
}

async function cmdKeysGenerate() {
  await ensureKeyDir();

  let existed = false;
  try {
    await fs.access(PRIVATE_KEY_PATH);
    existed = true;
  } catch { /* not found — will generate */ }

  if (existed) {
    // Load and display existing key
    const pubPem = await fs.readFile(PUBLIC_KEY_PATH, 'utf8');
    const pubKey = crypto.createPublicKey(pubPem);
    const b64 = pubKey.export({ type: 'spki', format: 'der' }).toString('base64');
    console.log('Key pair already exists (run hub to regenerate or delete key files):');
    console.log(`  Public key: ${b64}`);
    console.log(`  Location:   ${KEY_DIR}`);
    return;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  await fs.writeFile(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await fs.writeFile(PUBLIC_KEY_PATH, publicKey.export({ type: 'spki', format: 'pem' }));

  const b64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  console.log('Generated new X25519 key pair:');
  console.log(`  Public key: ${b64}`);
  console.log(`  Location:   ${KEY_DIR}`);
}

async function cmdKeysShow() {
  try {
    const pubPem = await fs.readFile(PUBLIC_KEY_PATH, 'utf8');
    const pubKey = crypto.createPublicKey(pubPem);
    const b64 = pubKey.export({ type: 'spki', format: 'der' }).toString('base64');
    console.log(b64);
  } catch {
    console.error('No key pair found. Run: pulse keys generate');
    process.exit(1);
  }
}

async function cmdKeysPeers() {
  try {
    const raw = await fs.readFile(PEER_KEYS_PATH, 'utf8');
    const peers = JSON.parse(raw);
    const entries = Object.entries(peers);
    if (entries.length === 0) {
      console.log('No peer keys known yet. Keys are exchanged automatically via peer-announce.');
      return;
    }
    console.log(`Known peer public keys (${entries.length}):`);
    for (const [nodeId, pubKeyB64] of entries) {
      // Show truncated key for readability
      const preview = pubKeyB64.length > 20
        ? pubKeyB64.slice(0, 20) + '...' + pubKeyB64.slice(-8)
        : pubKeyB64;
      console.log(`  ${nodeId.padEnd(16)} ${preview}`);
    }
  } catch {
    console.log('No peer keys file found yet. Keys are exchanged automatically via peer-announce.');
  }
}

async function cmdKeysTrust(args) {
  // args: ['node', 'cli.js', 'keys', 'trust', '<nodeId>', '<publicKeyBase64>']
  const nodeId    = args[4];
  const pubKeyB64 = args[5];
  if (!nodeId || !pubKeyB64) {
    console.error('Usage: pulse keys trust <nodeId> <publicKeyBase64>');
    process.exit(1);
  }

  // Validate the key is a valid X25519 public key (SPKI DER in base64)
  try {
    const der = Buffer.from(pubKeyB64, 'base64');
    crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (err) {
    console.error(`Invalid public key: ${err.message}`);
    console.error('Expected: base64-encoded SPKI DER (as output by "pulse keys show")');
    process.exit(1);
  }

  await ensureKeyDir();
  let peers = {};
  try {
    const raw = await fs.readFile(PEER_KEYS_PATH, 'utf8');
    peers = JSON.parse(raw);
  } catch { /* no existing file — start fresh */ }

  const wasKnown = !!peers[nodeId];
  peers[nodeId] = pubKeyB64;
  await fs.writeFile(PEER_KEYS_PATH, JSON.stringify(peers, null, 2));

  if (wasKnown) {
    console.log(`Updated public key for ${nodeId}`);
  } else {
    console.log(`Trusted new peer: ${nodeId}`);
  }
  console.log(`  Key: ${pubKeyB64.slice(0, 20)}...`);
}

async function cmdKeys(args) {
  const subcommand = args[3];
  switch (subcommand) {
    case 'generate': await cmdKeysGenerate();     break;
    case 'show':     await cmdKeysShow();          break;
    case 'peers':    await cmdKeysPeers();         break;
    case 'trust':    await cmdKeysTrust(args);     break;
    default:
      console.log('pulse keys - Key management for E2E encryption');
      console.log('');
      console.log('Commands:');
      console.log('  pulse keys generate              - generate keypair (or show existing)');
      console.log('  pulse keys show                  - display public key (base64)');
      console.log('  pulse keys peers                 - list known peer public keys');
      console.log('  pulse keys trust <nodeId> <key>  - manually trust a peer\'s public key');
      process.exit(subcommand ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const args    = process.argv;
const command = args[2];

try {
  switch (command) {
    case 'status':        await cmdStatus();                break;
    case 'peers':         await cmdPeers();                 break;
    case 'send':          await cmdSend(args);              break;
    case 'broadcast':     await cmdBroadcast(args);         break;
    case 'conversations': await cmdConversations();         break;
    case 'keys':          await cmdKeys(args);              break;
    default:
      console.log('agent-pulse CLI');
      console.log('');
      console.log('Commands:');
      console.log('  pulse status                      - hub status and connected peers');
      console.log('  pulse peers                       - list peers with latency');
      console.log('  pulse send <agent> <type> <msg>   - send a message');
      console.log('  pulse broadcast <msg>             - broadcast to all peers');
      console.log('  pulse conversations               - list active conversations');
      console.log('  pulse keys generate               - generate X25519 keypair');
      console.log('  pulse keys show                   - display your public key');
      console.log('  pulse keys peers                  - list known peer public keys');
      console.log('  pulse keys trust <nodeId> <key>   - manually trust a peer key');
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
