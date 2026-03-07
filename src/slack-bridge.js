#!/usr/bin/env node
/**
 * slack-bridge.js - One-way bridge: agent-pulse hub -> Slack
 *
 * Subscribes to the hub's SSE stream and forwards pulse messages to a Slack
 * channel. Messages in the same conversation are threaded together via
 * reply_broadcast so they appear in both the channel and the thread.
 *
 * Environment variables:
 *   SLACK_TOKEN   - Slack bot token (xoxb-...)
 *   SLACK_CHANNEL - Channel ID (default: C0ADANGB9RD)
 *   PULSE_API_URL - Hub SSE base URL (default: http://127.0.0.1:18801)
 *   SHRIMPNET_URL - ShrimpNet ingest URL (default: http://localhost:3000)
 *   SHRIMPNET_TOKEN - ShrimpNet ingest bearer token
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SLACK_TOKEN      = process.env.SLACK_TOKEN      || '';
const SLACK_CHANNEL    = process.env.SLACK_CHANNEL    || 'C0ADANGB9RD';
const PULSE_API_URL    = process.env.PULSE_API_URL    || 'http://127.0.0.1:18801';
const SHRIMPNET_URL    = process.env.SHRIMPNET_URL    || 'http://localhost:3000';
const SHRIMPNET_TOKEN  = process.env.SHRIMPNET_TOKEN  || '';
const SLACK_API        = 'https://slack.com/api';

// ---------------------------------------------------------------------------
// ShrimpNet ingest helper
// ---------------------------------------------------------------------------

async function ingestToShrimpNet(msg) {
  if (!SHRIMPNET_TOKEN) {
    return;
  }
  try {
    const res = await fetch(`${SHRIMPNET_URL}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SHRIMPNET_TOKEN}`,
      },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      console.error(`[slack-bridge] ShrimpNet ingest error: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[slack-bridge] ShrimpNet ingest failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory thread map: conversationId -> Slack thread_ts
// Resets on restart - that's acceptable for now.
// ---------------------------------------------------------------------------

const threadMap = new Map();

// ---------------------------------------------------------------------------
// Slack API helpers (native fetch, no deps)
// ---------------------------------------------------------------------------

async function slackPost(method, body) {
  if (!SLACK_TOKEN) {
    console.warn('[slack-bridge] SLACK_TOKEN not set - skipping Slack post');
    return { ok: false, error: 'no_token' };
  }

  const res = await fetch(`${SLACK_API}/${method}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json; charset=utf-8',
      'Authorization': `Bearer ${SLACK_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error(`[slack-bridge] Slack API error (${method}):`, data.error);
  }
  return data;
}

// Post a pulse message to Slack. Thread automatically if conversationId seen before.
async function postToSlack(msg) {
  const convId    = msg.conversationId || 'unknown';
  const sender    = msg.from           || 'unknown';
  const msgType   = msg.type           || 'message';
  const timestamp = msg.timestamp
    ? new Date(msg.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' })
    : new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

  // Build payload text.
  const payloadText = msg.payload
    ? (typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload, null, 2))
    : '(no payload)';

  // Extract subject and body for natural display
  const subject = msg.payload?.subject || '';
  const body    = msg.payload?.body    || payloadText;
  const to      = msg.to === '*' ? 'all' : (msg.to || '?');

  // Natural format: sender icon + message, metadata in footer
  const headerText = subject
    ? `*${subject}*\n${body.substring(0, 2800)}`
    : body.substring(0, 2900);

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*:satellite: ${sender}* -> *${to}* [${msgType}]\n\n${headerText}`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `conv: \`${convId.substring(0, 20)}...\` | ${timestamp} | msg: \`${(msg.id || 'n/a').substring(0, 12)}...\`` },
      ],
    },
  ];

  const existingThreadTs = threadMap.get(convId);

  const postBody = {
    channel: SLACK_CHANNEL,
    text:    `[pulse] ${sender} -> ${msg.to || '*'} (${msgType})`,
    blocks,
  };

  if (existingThreadTs) {
    // Reply into existing thread.
    postBody.thread_ts       = existingThreadTs;
    postBody.reply_broadcast = true;
  }

  const result = await slackPost('chat.postMessage', postBody);

  // Store thread_ts on first message of each conversation.
  if (result.ok && result.ts && !existingThreadTs) {
    threadMap.set(convId, result.ts);
  }

  return result;
}

// ---------------------------------------------------------------------------
// SSE subscriber
// ---------------------------------------------------------------------------

export class SlackBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.pulseUrl    = opts.pulseUrl    || PULSE_API_URL;
    this.slackToken  = opts.slackToken  || SLACK_TOKEN;
    this.slackChannel = opts.slackChannel || SLACK_CHANNEL;
    this._active     = false;
    this._retryDelay = 3000;
  }

  async start() {
    this._active = true;
    console.log(`[slack-bridge] Starting. Hub: ${this.pulseUrl}  Channel: ${this.slackChannel}`);
    await this._connect();
  }

  async stop() {
    this._active = false;
    if (this._abortController) {
      this._abortController.abort();
    }
    console.log('[slack-bridge] Stopped.');
  }

  async _connect() {
    if (!this._active) return;

    this._abortController = new AbortController();
    const url = `${this.pulseUrl}/events`;

    try {
      console.log(`[slack-bridge] Connecting to SSE at ${url}`);
      const res = await fetch(url, {
        headers: { 'Accept': 'text/event-stream' },
        signal:  this._abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connect failed: HTTP ${res.status}`);
      }

      console.log('[slack-bridge] SSE connected. Listening for pulse messages...');
      this._retryDelay = 3000; // reset backoff on successful connect

      // Stream-read the SSE response line by line.
      const reader    = res.body.getReader();
      const decoder   = new TextDecoder();
      let   buffer    = '';

      while (this._active) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are delimited by double newline.
        const events = buffer.split('\n\n');
        buffer = events.pop(); // Keep incomplete chunk.

        for (const rawEvent of events) {
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;

          const jsonStr = dataLine.slice(5).trim();
          if (!jsonStr) continue;

          let msg;
          try {
            msg = JSON.parse(jsonStr);
          } catch {
            console.warn('[slack-bridge] Could not parse SSE data:', jsonStr.substring(0, 100));
            continue;
          }

          // Only forward pulse protocol messages.
          if (msg.protocol !== 'pulse/1.0') continue;

          this.emit('message', msg);

          try {
            await Promise.all([
              postToSlack(msg),
              ingestToShrimpNet(msg),
            ]);
          } catch (err) {
            console.error('[slack-bridge] Failed to post:', err.message);
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // intentional stop
      console.error(`[slack-bridge] SSE error: ${err.message}`);
    }

    // Reconnect with backoff.
    if (this._active) {
      console.log(`[slack-bridge] Reconnecting in ${this._retryDelay}ms...`);
      await new Promise(r => setTimeout(r, this._retryDelay));
      this._retryDelay = Math.min(this._retryDelay * 2, 60000);
      await this._connect();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const bridge = new SlackBridge();
  await bridge.start();

  process.on('SIGTERM', () => bridge.stop());
  process.on('SIGINT',  () => bridge.stop());
}
