/**
 * envelope-crypto.js — Meshtastic-style encrypted envelopes for pulse/2.0
 *
 * Design:
 *   - Each node has an X25519 key pair (generated on first boot, persisted)
 *   - Public keys exchanged via peer-announce messages
 *   - Messages encrypted per-recipient: AES-256-GCM with X25519 ECDH shared secret
 *   - Relay nodes see routing headers but payload is opaque ciphertext
 *   - Conversations: sender encrypts once per participant (multi-recipient envelope)
 *
 * Envelope format (encrypted):
 *   {
 *     protocol: "pulse/2.0",
 *     messageId: "...",
 *     type: "encrypted",
 *     from: "agent-a",
 *     to: "agent-b",           // or conversationId for group
 *     ttl: 3,
 *     path: ["agent-a"],
 *     timestamp: ...,
 *     encrypted: {
 *       algo: "x25519-aes256gcm",
 *       senderPub: "<base64>",
 *       recipients: {
 *         "agent-b": { ciphertext, nonce, tag },
 *         "agent-e": { ciphertext, nonce, tag }
 *       }
 *     }
 *   }
 *
 * Only nodes in `recipients` can decrypt. Relay nodes forward opaquely.
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const KEY_DIR = path.join(os.homedir(), '.openclaw', 'pulse-keys');
const PRIVATE_KEY_PATH = path.join(KEY_DIR, 'x25519.pem');
const PUBLIC_KEY_PATH = path.join(KEY_DIR, 'x25519.pub.pem');
const PEER_KEYS_PATH = path.join(KEY_DIR, 'peer-keys.json');

export class EnvelopeCrypto {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.privateKey = null;
    this.publicKey = null;
    this.publicKeyB64 = null;
    this.peerKeys = {};       // nodeId -> base64 public key
  }

  async init() {
    await fs.mkdir(KEY_DIR, { recursive: true });

    try {
      const privPem = await fs.readFile(PRIVATE_KEY_PATH, 'utf8');
      const pubPem = await fs.readFile(PUBLIC_KEY_PATH, 'utf8');
      this.privateKey = crypto.createPrivateKey(privPem);
      this.publicKey = crypto.createPublicKey(pubPem);
    } catch {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
      this.privateKey = privateKey;
      this.publicKey = publicKey;
      await fs.writeFile(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      await fs.writeFile(PUBLIC_KEY_PATH, publicKey.export({ type: 'spki', format: 'pem' }));
      console.log(`[crypto] Generated X25519 key pair for ${this.nodeId}`);
    }

    this.publicKeyB64 = this.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    try {
      const data = await fs.readFile(PEER_KEYS_PATH, 'utf8');
      this.peerKeys = JSON.parse(data);
    } catch {
      this.peerKeys = {};
    }

    console.log(`[crypto] Initialized — ${Object.keys(this.peerKeys).length} peer keys known`);
  }

  async registerPeerKey(nodeId, publicKeyB64) {
    if (!publicKeyB64 || nodeId === this.nodeId) return;
    if (this.peerKeys[nodeId] === publicKeyB64) return;

    this.peerKeys[nodeId] = publicKeyB64;
    try {
      await fs.writeFile(PEER_KEYS_PATH, JSON.stringify(this.peerKeys, null, 2));
    } catch (err) {
      console.warn(`[crypto] Failed to persist peer keys: ${err.message}`);
    }
    console.log(`[crypto] Registered public key for ${nodeId}`);
  }

  getPublicKeyB64() {
    return this.publicKeyB64;
  }

  hasPeerKey(nodeId) {
    return !!this.peerKeys[nodeId];
  }

  _deriveSharedKey(peerPubB64) {
    const peerPubDer = Buffer.from(peerPubB64, 'base64');
    const peerKey = crypto.createPublicKey({ key: peerPubDer, format: 'der', type: 'spki' });
    const shared = crypto.diffieHellman({ privateKey: this.privateKey, publicKey: peerKey });
    return crypto.hkdfSync('sha256', shared, '', 'pulse-envelope-v1', 32);
  }

  /**
   * Encrypt payload for specific recipients.
   * @param {object} payload - plaintext payload
   * @param {string[]} recipientIds - nodeIds who can decrypt
   * @returns {object|null} encrypted block for envelope
   */
  encrypt(payload, recipientIds) {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const recipients = {};

    for (const nodeId of recipientIds) {
      const peerPub = this.peerKeys[nodeId];
      if (!peerPub) {
        console.warn(`[crypto] No public key for ${nodeId} — cannot encrypt`);
        continue;
      }
      try {
        const aesKey = this._deriveSharedKey(peerPub);
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), nonce);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        recipients[nodeId] = {
          ciphertext: encrypted.toString('base64'),
          nonce: nonce.toString('base64'),
          tag: tag.toString('base64'),
        };
      } catch (err) {
        console.warn(`[crypto] Encrypt failed for ${nodeId}: ${err.message}`);
      }
    }

    if (Object.keys(recipients).length === 0) return null;

    return {
      algo: 'x25519-aes256gcm',
      senderPub: this.publicKeyB64,
      recipients,
    };
  }

  /**
   * Decrypt an envelope's encrypted block.
   * @returns {object|null} decrypted payload or null if not a recipient
   */
  decrypt(encrypted) {
    if (!encrypted || encrypted.algo !== 'x25519-aes256gcm') return null;
    const myBlock = encrypted.recipients?.[this.nodeId];
    if (!myBlock) return null;

    try {
      const aesKey = this._deriveSharedKey(encrypted.senderPub);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(aesKey),
        Buffer.from(myBlock.nonce, 'base64')
      );
      decipher.setAuthTag(Buffer.from(myBlock.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(myBlock.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (err) {
      console.warn(`[crypto] Decrypt failed: ${err.message}`);
      return null;
    }
  }

  canDecrypt(encrypted) {
    return !!(encrypted?.recipients?.[this.nodeId]);
  }

  static isEncrypted(envelope) {
    return envelope?.type === 'encrypted' && !!envelope?.encrypted;
  }
}
