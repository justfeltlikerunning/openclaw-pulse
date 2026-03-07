#!/usr/bin/env node
/**
 * session-bridge.js - File-based inbox bridge for in-session agent awareness
 *
 * Subscribes to the hub (either via EventEmitter for in-process use, or via
 * SSE for standalone use) and writes each incoming message to a file in:
 *
 *   state/inbox/<timestamp>_<msg_id>.json
 *
 * Any agent framework (OpenClaw heartbeat, cron, shell script) can poll this
 * directory to pick up messages without depending on WebSocket infrastructure.
 *
 * Each inbox file contains the full message envelope including any conversation
 * context rounds from previous turns.
 *
 * Environment variables:
 *   PULSE_API_URL   - Hub SSE base URL (default: http://127.0.0.1:18801)
 *   PULSE_INBOX_DIR - Directory for inbox files (default: state/inbox)
 */

import { EventEmitter }   from 'events';
import { promises as fs } from 'fs';
import path               from 'path';
import { fileURLToPath }  from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const PULSE_API_URL   = process.env.PULSE_API_URL   || 'http://127.0.0.1:18801';
const PULSE_INBOX_DIR = process.env.PULSE_INBOX_DIR || path.join(ROOT, 'state', 'inbox');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// SessionBridge class
// ---------------------------------------------------------------------------

export class SessionBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.inboxDir  - Directory to write inbox files (overrides env)
   * @param {string}  opts.pulseUrl  - Hub SSE URL (for standalone SSE mode)
   * @param {object}  opts.hub       - Hub EventEmitter instance (for in-process mode)
   */
  constructor(opts = {}) {
    super();
    this.inboxDir    = opts.inboxDir  || PULSE_INBOX_DIR;
    this.pulseUrl    = opts.pulseUrl  || PULSE_API_URL;
    this.hub         = opts.hub       || null;
    this._active     = false;
    this._retryDelay = 3000;
  }

  async start() {
    this._active = true;
    await ensureDir(this.inboxDir);
    console.log(`[session-bridge] Inbox dir: ${this.inboxDir}`);

    if (this.hub) {
      // In-process mode: subscribe to hub's EventEmitter directly.
      console.log('[session-bridge] Using in-process hub event bus.');
      this._hubHandler = async (msg) => {
        await this._writeInbox(msg);
      };
      this.hub.on('message', this._hubHandler);
    } else {
      // Standalone mode: connect via SSE.
      await this._connectSSE();
    }
  }

  async stop() {
    this._active = false;
    if (this.hub && this._hubHandler) {
      this.hub.off('message', this._hubHandler);
    }
    if (this._abortController) {
      this._abortController.abort();
    }
    console.log('[session-bridge] Stopped.');
  }

  // Write a message to the inbox directory.
  async _writeInbox(msg) {
    if (!msg || msg.protocol !== 'pulse/1.0') return;

    const ts    = new Date(msg.timestamp || Date.now()).getTime();
    const msgId = (msg.id || `msg_${ts}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fname = `${ts}_${msgId}.json`;
    const fpath = path.join(this.inboxDir, fname);

    const inboxEntry = {
      receivedAt:          new Date().toISOString(),
      id:                  msg.id,
      conversationId:      msg.conversationId,
      from:                msg.from,
      to:                  msg.to,
      type:                msg.type,
      timestamp:           msg.timestamp,
      payload:             msg.payload,
      // Include conversation context if the hub attached it.
      conversationContext: msg.conversationContext || null,
    };

    try {
      await fs.writeFile(fpath, JSON.stringify(inboxEntry, null, 2));
      console.log(`[session-bridge] Wrote inbox: ${fname}`);
      this.emit('inbox:written', { file: fpath, msg: inboxEntry });
    } catch (err) {
      console.error(`[session-bridge] Failed to write inbox file: ${err.message}`);
    }
  }

  // List unread inbox files (sorted oldest-first).
  async listInbox() {
    await ensureDir(this.inboxDir);
    const files = await fs.readdir(this.inboxDir);
    return files
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => path.join(this.inboxDir, f));
  }

  // Read and remove an inbox file (mark as consumed).
  async consume(filePath) {
    try {
      const raw  = await fs.readFile(filePath, 'utf8');
      const msg  = JSON.parse(raw);
      await fs.unlink(filePath);
      return msg;
    } catch (err) {
      console.error(`[session-bridge] Failed to consume ${filePath}: ${err.message}`);
      return null;
    }
  }

  // Drain all current inbox files and return them.
  async drainInbox() {
    const files = await this.listInbox();
    const msgs  = [];
    for (const f of files) {
      const msg = await this.consume(f);
      if (msg) msgs.push(msg);
    }
    return msgs;
  }

  // -------------------------------------------------------------------------
  // Standalone SSE mode
  // -------------------------------------------------------------------------

  async _connectSSE() {
    if (!this._active) return;

    this._abortController = new AbortController();
    const url = `${this.pulseUrl}/events`;

    try {
      console.log(`[session-bridge] Connecting to SSE at ${url}`);
      const res = await fetch(url, {
        headers: { 'Accept': 'text/event-stream' },
        signal:  this._abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connect failed: HTTP ${res.status}`);
      }

      console.log('[session-bridge] SSE connected. Writing incoming messages to inbox...');
      this._retryDelay = 3000;

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (this._active) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop();

        for (const rawEvent of events) {
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;

          const jsonStr = dataLine.slice(5).trim();
          if (!jsonStr) continue;

          let msg;
          try {
            msg = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          await this._writeInbox(msg);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(`[session-bridge] SSE error: ${err.message}`);
    }

    if (this._active) {
      console.log(`[session-bridge] Reconnecting in ${this._retryDelay}ms...`);
      await new Promise(r => setTimeout(r, this._retryDelay));
      this._retryDelay = Math.min(this._retryDelay * 2, 60000);
      await this._connectSSE();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point (standalone mode)
// ---------------------------------------------------------------------------

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const bridge = new SessionBridge();
  await bridge.start();

  process.on('SIGTERM', () => bridge.stop());
  process.on('SIGINT',  () => bridge.stop());
}
