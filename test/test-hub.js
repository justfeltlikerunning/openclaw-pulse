/**
 * test-hub.js - Integration tests for agent-pulse
 *
 * Tests:
 *   1. Start two hub instances (agent-a on ports 18810/18811,
 *                               agent-b on ports 18820/18821)
 *   2. Verify they connect to each other
 *   3. Send a message from hub-a to hub-b, verify receipt
 *   4. Send a message from hub-b to hub-a, verify receipt
 *   5. Broadcast from hub-a, verify hub-b receives it
 *   6. Test reconnect after disconnect
 *   7. Verify audit log was written
 *
 * Ports used (all localhost, all ephemeral for testing):
 *   agent-a WS:  18810   API: 18811
 *   agent-b WS:  18820   API: 18821
 */

import { Hub }           from '../src/hub.js';
import { SessionBridge } from '../src/session-bridge.js';
import { promises as fs } from 'fs';
import path               from 'path';
import { fileURLToPath }  from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Test state directories (isolated per test run)
// ---------------------------------------------------------------------------

const TEST_RUN    = `test-${Date.now()}`;
const STATE_DIR_A = path.join(ROOT, 'state', 'test', TEST_RUN, 'a');
const STATE_DIR_B = path.join(ROOT, 'state', 'test', TEST_RUN, 'b');
const LOG_DIR_A   = path.join(ROOT, 'logs',  'test', TEST_RUN, 'a');
const LOG_DIR_B   = path.join(ROOT, 'logs',  'test', TEST_RUN, 'b');

// Tokens must match across the two configs so the identity handshake succeeds.
const TOKEN_A = 'test-token-agent-a';
const TOKEN_B = 'test-token-agent-b';

// ---------------------------------------------------------------------------
// Hub factory
// ---------------------------------------------------------------------------

function makeConfig(name, wsPort, apiPort, peerName, peerPort, peerToken, logDir, stateDir) {
  return {
    agent:   name,
    port:    wsPort,
    apiPort,
    peers: {
      [peerName]: {
        ip:    '127.0.0.1',
        port:  peerPort,
        token: peerToken,
      },
    },
    groups: {},
    // Per-instance paths so both hubs can coexist in the same process.
    auditLogPath:     path.join(logDir, 'pulse-audit.jsonl'),
    conversationsDir: path.join(stateDir, 'conversations'),
  };
}

// ---------------------------------------------------------------------------
// Simple assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed++;
  }
}

function assertEq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}  actual=${JSON.stringify(actual)}  expected=${JSON.stringify(expected)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Utility: wait for an event with a timeout
// ---------------------------------------------------------------------------

function waitForEvent(emitter, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    emitter.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// ---------------------------------------------------------------------------
// Utility: wait for a 'message' event matching a predicate
// ---------------------------------------------------------------------------

function waitForMessage(hub, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for matching message after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(msg) {
      if (predicate(msg)) {
        clearTimeout(timer);
        hub.removeListener('message', handler);
        resolve(msg);
      }
    }
    hub.on('message', handler);
  });
}

// ---------------------------------------------------------------------------
// Utility: sleep
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Utility: REST API call (plain fetch)
// ---------------------------------------------------------------------------

async function apiGet(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('=== agent-pulse integration tests ===\n');

  // Ensure isolated directories exist.
  await fs.mkdir(LOG_DIR_A,   { recursive: true });
  await fs.mkdir(LOG_DIR_B,   { recursive: true });
  await fs.mkdir(STATE_DIR_A, { recursive: true });
  await fs.mkdir(STATE_DIR_B, { recursive: true });

  // -------------------------------------------------------------------------
  // Test 1: Start two hub instances
  // -------------------------------------------------------------------------

  console.log('Test 1: Start two hub instances');

  // Hub A knows about Hub B (and vice-versa).
  const configA = makeConfig('agent-a', 18810, 18811, 'agent-b', 18820, TOKEN_B, LOG_DIR_A, STATE_DIR_A);
  const configB = makeConfig('agent-b', 18820, 18821, 'agent-a', 18810, TOKEN_A, LOG_DIR_B, STATE_DIR_B);

  // Hub A uses token TOKEN_A so Hub B can authenticate it, and vice-versa.
  // The token in the registry is what the REMOTE hub expects us to send.
  // So Hub A sends TOKEN_B when connecting to Hub B (Hub B checks its own registry).
  // But Hub B's registry says agent-a's token is TOKEN_A.
  // Therefore: Hub A must send TOKEN_A (its own identity token) to Hub B.
  // Correction: the token in agent-registry.json is the bearer token that we
  // send to authenticate ourselves to that peer.  The peer's hub checks the
  // incoming token against ITS OWN registry entry for us.
  //
  // Example:
  //   Hub A registry: { "agent-b": { token: "TOKEN_B" } }
  //     -> Hub A sends TOKEN_B when connecting to Hub B
  //   Hub B registry: { "agent-a": { token: "TOKEN_B" } }  <-- must match
  //     -> Hub B accepts TOKEN_B for agent-a
  //
  // So both sides must agree on the same shared secret.  We simplify by using
  // a single token per directed pair (A->B, B->A can differ).

  // Hub A dials Hub B: Hub A will send configA.peers['agent-b'].token = TOKEN_B
  // Hub B checks its registry for 'agent-a': configB.peers['agent-a'].token
  // For auth to succeed, configB.peers['agent-a'].token must equal TOKEN_B
  // BUT configB has agent-a with TOKEN_A ... so let's use the same token for both.

  // Fix: use a single shared token for simplicity in tests.
  const SHARED_TOKEN = 'shared-test-secret-2026';
  configA.peers['agent-b'].token = SHARED_TOKEN;
  configB.peers['agent-a'].token = SHARED_TOKEN;

  const hubA = new Hub(configA);
  await hubA.start();

  const hubB = new Hub(configB);
  await hubB.start();

  assert(true, 'Both hubs started without error');

  // -------------------------------------------------------------------------
  // Test 2: Verify they connect to each other
  // -------------------------------------------------------------------------

  console.log('\nTest 2: Verify peer connection');

  // Hub A is dialing Hub B; wait for the 'peer:connected' event on Hub A.
  try {
    await waitForEvent(hubA, 'peer:connected', 6000);
    assert(true, 'Hub A emitted peer:connected for Hub B');
  } catch (err) {
    assert(false, `Hub A peer:connected: ${err.message}`);
  }

  // Give Hub B a moment to complete its own outbound connection to Hub A.
  await sleep(1500);

  const peersA = hubA.connectedPeers();
  const peersB = hubB.connectedPeers();

  assert(peersA.includes('agent-b'), 'Hub A sees agent-b as connected');
  assert(peersB.includes('agent-a'), 'Hub B sees agent-a as connected');

  // -------------------------------------------------------------------------
  // Test 3: Send a message from Hub A to Hub B
  // -------------------------------------------------------------------------

  console.log('\nTest 3: Message A -> B');

  // Override env back to Hub B's log dir before Hub B writes audit.
  // (We do not re-override the env here - the audit log path is captured at
  //  Hub construction time inside the AUDIT_LOG_PATH module variable.
  //  Because we export Hub as a class and the paths are module-level constants,
  //  we need a different approach for isolation in tests.
  //
  //  Simpler: just verify the 'message' event fires on Hub B.)

  const msgPromise = waitForMessage(hubB, (m) => m.from === 'agent-a', 5000);

  const sendResult = await hubA.send('agent-b', 'request', {
    subject: 'test-query',
    body:    'Hello from agent-a',
  });

  assert(sendResult.delivered, 'Hub A send() returned delivered=true');
  assert(typeof sendResult.messageId === 'string', 'send() returned a messageId');
  assert(typeof sendResult.conversationId === 'string', 'send() returned a conversationId');

  try {
    const received = await msgPromise;
    assert(received.from === 'agent-a', 'Hub B received message from agent-a');
    assert(received.to   === 'agent-b', 'Hub B received message addressed to agent-b');
    assertEq(received.payload?.body, 'Hello from agent-a', 'Message payload body is correct');
    assertEq(received.protocol, 'pulse/1.0', 'Protocol is pulse/1.0');
  } catch (err) {
    assert(false, `Hub B message receipt: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 4: Send a message from Hub B to Hub A
  // -------------------------------------------------------------------------

  console.log('\nTest 4: Message B -> A');

  const msgPromiseA = waitForMessage(hubA, (m) => m.from === 'agent-b', 5000);

  const sendResultB = await hubB.send('agent-a', 'response', {
    subject: 'test-reply',
    body:    'Hello back from agent-b',
  });

  assert(sendResultB.delivered, 'Hub B send() returned delivered=true');

  try {
    const received = await msgPromiseA;
    assert(received.from === 'agent-b', 'Hub A received message from agent-b');
    assertEq(received.payload?.body, 'Hello back from agent-b', 'Reply payload body is correct');
  } catch (err) {
    assert(false, `Hub A message receipt: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 5: Broadcast
  // -------------------------------------------------------------------------

  console.log('\nTest 5: Broadcast from Hub A');

  const broadcastReceivedByB = waitForMessage(hubB, (m) => m.type === 'notification' && m.to === 'agent-b', 5000);

  const broadcastResult = await hubA.send('*', 'notification', {
    body: 'Broadcast from agent-a',
  });

  assert(typeof broadcastResult.results === 'object', 'Broadcast returned results map');

  try {
    const bMsg = await broadcastReceivedByB;
    assert(bMsg.from === 'agent-a', 'Hub B received broadcast from agent-a');
    assertEq(bMsg.payload?.body, 'Broadcast from agent-a', 'Broadcast payload correct');
  } catch (err) {
    assert(false, `Hub B broadcast receipt: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 6: Reconnect after disconnect
  // -------------------------------------------------------------------------

  console.log('\nTest 6: Reconnect after disconnect');

  // Find Hub A's outbound WS to Hub B and forcefully terminate it.
  const outboundState = hubA.outboundPeers.get('agent-b');
  if (outboundState?.ws) {
    outboundState.ws.terminate(); // hard close, no graceful FIN
  }

  // Immediately check status: should show disconnected.
  await sleep(200);
  const statusAfterDisconnect = outboundState?.status;
  assert(
    statusAfterDisconnect === 'disconnected' || statusAfterDisconnect === 'error',
    'Hub A outbound status is disconnected/error after terminate'
  );

  // Wait for reconnect (backoff starts at 1000ms).
  console.log('  Waiting for auto-reconnect (up to 5s)...');

  try {
    await waitForEvent(hubA, 'peer:connected', 7000);
    assert(true, 'Hub A reconnected to Hub B after disconnect');

    // Allow a moment for the connection to settle, then send a message.
    await sleep(500);
    const reconnectMsgP = waitForMessage(hubB, (m) => m.payload?.subject === 'reconnect-test', 5000);
    await hubA.send('agent-b', 'request', { subject: 'reconnect-test', body: 'post-reconnect message' });
    const rm = await reconnectMsgP;
    assert(rm.payload?.subject === 'reconnect-test', 'Message delivered successfully after reconnect');
  } catch (err) {
    assert(false, `Reconnect test: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 7: Audit log was written
  // -------------------------------------------------------------------------

  console.log('\nTest 7: Audit log written');

  // Small delay to ensure async file writes have flushed.
  await sleep(300);

  // Hub A's audit log path (from instance config).
  const auditPathA = hubA.auditLogPath;

  try {
    const logContent = await fs.readFile(auditPathA, 'utf8');
    const lines = logContent.trim().split('\n').filter(Boolean);
    assert(lines.length > 0, `Audit log has ${lines.length} entries`);

    // Verify each line is valid JSON with required fields.
    let allValid = true;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry.timestamp || !entry.id || !entry.from) {
          allValid = false;
          break;
        }
      } catch {
        allValid = false;
        break;
      }
    }
    assert(allValid, 'All audit log lines are valid JSON with required fields');
  } catch (err) {
    assert(false, `Audit log readable: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 8: REST API /status
  // -------------------------------------------------------------------------

  console.log('\nTest 8: REST API /status');

  try {
    const status = await apiGet(18811, '/status');
    assertEq(status.agent, 'agent-a', 'API /status returns correct agent name');
    assert(typeof status.uptime === 'number', 'API /status returns uptime');
    assert(typeof status.peers === 'object', 'API /status returns peers object');
  } catch (err) {
    assert(false, `REST API /status: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 9: REST API /send
  // -------------------------------------------------------------------------

  console.log('\nTest 9: REST API /send');

  try {
    const recvP = waitForMessage(hubB, (m) => m.payload?.subject === 'api-send-test', 5000);
    const result = await fetch('http://127.0.0.1:18811/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        to:      'agent-b',
        type:    'request',
        payload: { subject: 'api-send-test', body: 'sent via REST API' },
      }),
    });
    const json = await result.json();
    assert(json.delivered, 'REST /send returned delivered=true');
    const m = await recvP;
    assert(m.payload?.subject === 'api-send-test', 'Hub B received message sent via REST API');
  } catch (err) {
    assert(false, `REST API /send: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 10: Conversation state persisted
  // -------------------------------------------------------------------------

  console.log('\nTest 10: Conversation state');

  try {
    // Create a conversation via Hub A's REST API.
    const createRes = await fetch('http://127.0.0.1:18811/conversations', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'collab', participants: ['agent-a', 'agent-b'] }),
    });
    const conv = await createRes.json();
    assert(typeof conv.conversationId === 'string', 'Created conversation has an ID');
    assertEq(conv.status, 'active', 'New conversation status is active');

    // Fetch it back.
    const fetchedConv = await apiGet(18811, `/conversations/${conv.conversationId}`);
    assertEq(fetchedConv.conversationId, conv.conversationId, 'Fetched conversation ID matches');
  } catch (err) {
    assert(false, `Conversation state: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 11: Multi-turn conversation (send 3 messages, verify rounds)
  // -------------------------------------------------------------------------

  console.log('\nTest 11: Multi-turn conversation');

  try {
    // Create a conversation via Hub A.
    const convRes = await fetch('http://127.0.0.1:18811/conversations', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'collab', participants: ['agent-a', 'agent-b'] }),
    });
    const conv = await convRes.json();
    assert(conv.conversationId, 'Multi-turn: conversation created');

    const convId = conv.conversationId;

    // Round 1: A -> B
    const round1P = waitForMessage(hubB, (m) => m.conversationId === convId && m.payload?.round === 1, 5000);
    await hubA.send('agent-b', 'request', { round: 1, body: 'Round one from A' }, { conversationId: convId });
    await round1P;

    // Round 2: B -> A (reply in same conversation)
    const round2P = waitForMessage(hubA, (m) => m.conversationId === convId && m.payload?.round === 2, 5000);
    await hubB.send('agent-a', 'response', { round: 2, body: 'Round two from B' }, { conversationId: convId });
    await round2P;

    // Round 3: A -> B again
    const round3P = waitForMessage(hubB, (m) => m.conversationId === convId && m.payload?.round === 3, 5000);
    await hubA.send('agent-b', 'request', { round: 3, body: 'Round three from A' }, { conversationId: convId });
    await round3P;

    // Allow disk writes to settle.
    await sleep(300);

    // Verify conversation state has 3 rounds.
    const savedConv = await hubA._loadConversation(convId);
    assert(savedConv !== null, 'Multi-turn: conversation persisted to disk');
    assertEq(savedConv.rounds.length, 3, 'Multi-turn: conversation has 3 rounds');
    assertEq(savedConv.rounds[0].from, 'agent-a', 'Round 1 sender is agent-a');
    assertEq(savedConv.rounds[1].from, 'agent-b', 'Round 2 sender is agent-b');
    assertEq(savedConv.rounds[2].from, 'agent-a', 'Round 3 sender is agent-a');
    assert(savedConv.participants.includes('agent-a'), 'Participants includes agent-a');
    assert(savedConv.participants.includes('agent-b'), 'Participants includes agent-b');
  } catch (err) {
    assert(false, `Multi-turn conversation: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 12: Park and resume conversation
  // -------------------------------------------------------------------------

  console.log('\nTest 12: Park and resume');

  try {
    // Create a conversation and send one message.
    const convRes = await fetch('http://127.0.0.1:18811/conversations', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'task' }),
    });
    const conv    = await convRes.json();
    const convId  = conv.conversationId;

    await hubA.send('agent-b', 'request', { body: 'Initial task' }, { conversationId: convId });
    await sleep(200);

    // Park it.
    const parkRes = await fetch(`http://127.0.0.1:18811/conversations/${convId}/park`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        resumeAt:     '2026-03-15T00:00:00Z',
        resumeReason: 'Waiting for end-of-month data',
      }),
    });
    const parked = await parkRes.json();

    assertEq(parked.status, 'parked', 'Park: status is parked');
    assert(parked.parkedAt, 'Park: parkedAt timestamp set');
    assertEq(parked.resumeAt, '2026-03-15T00:00:00Z', 'Park: resumeAt stored correctly');
    assertEq(parked.resumeReason, 'Waiting for end-of-month data', 'Park: resumeReason stored');

    // Resume it.
    const resumeRes = await fetch(`http://127.0.0.1:18811/conversations/${convId}/resume`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const resumed = await resumeRes.json();

    assertEq(resumed.status, 'active', 'Resume: status back to active');
    assert(resumed.resumedAt, 'Resume: resumedAt timestamp set');
    assert(!resumed.parkedAt, 'Resume: parkedAt cleared');
    assert(!resumed.resumeAt, 'Resume: resumeAt cleared');

    // Conversation should still have its round from before parking.
    await sleep(200);
    const loaded = await hubA._loadConversation(convId);
    assert(loaded.rounds.length >= 1, 'Resume: conversation still has round history');
  } catch (err) {
    assert(false, `Park and resume: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 13: Conversation context propagation
  // -------------------------------------------------------------------------

  console.log('\nTest 13: Conversation context propagation');

  try {
    // Create conversation and send two rounds.
    const convRes = await fetch('http://127.0.0.1:18811/conversations', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'collab' }),
    });
    const conv   = await convRes.json();
    const convId = conv.conversationId;

    // First round (no context yet).
    const r1P = waitForMessage(hubB, (m) => m.conversationId === convId && m.payload?.round === 1, 5000);
    await hubA.send('agent-b', 'request', { round: 1, body: 'Context test round one' }, { conversationId: convId });
    const r1 = await r1P;
    // First round has no prior context.
    assert(!r1.conversationContext || r1.conversationContext.rounds.length === 0,
      'Context: round 1 has no prior rounds in context');

    await sleep(300); // Allow disk write.

    // Second round - should carry round-1 context.
    const r2P = waitForMessage(hubB, (m) => m.conversationId === convId && m.payload?.round === 2, 5000);
    await hubA.send('agent-b', 'request', { round: 2, body: 'Context test round two' }, { conversationId: convId });
    const r2 = await r2P;

    assert(r2.conversationContext !== undefined && r2.conversationContext !== null,
      'Context: round 2 message includes conversationContext');
    assert(Array.isArray(r2.conversationContext?.rounds),
      'Context: conversationContext.rounds is an array');
    assert(r2.conversationContext.rounds.length >= 1,
      'Context: round 2 context contains at least one prior round');
    assertEq(r2.conversationContext.rounds[0].from, 'agent-a',
      'Context: prior round in context is from agent-a');
  } catch (err) {
    assert(false, `Conversation context propagation: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Test 14: Session bridge (file-based inbox)
  // -------------------------------------------------------------------------

  console.log('\nTest 14: Session bridge inbox');

  let sessionBridge = null;
  const INBOX_DIR = path.join(ROOT, 'state', 'test', TEST_RUN, 'inbox');

  try {
    // Create the bridge in in-process mode, attached to Hub B.
    sessionBridge = new SessionBridge({ hub: hubB, inboxDir: INBOX_DIR });
    await sessionBridge.start();

    // Send a message to Hub B; the bridge should write it to the inbox.
    const inboxWritten = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('inbox:written timeout')), 5000);
      sessionBridge.once('inbox:written', (ev) => { clearTimeout(t); resolve(ev); });
    });

    await hubA.send('agent-b', 'notification', { body: 'inbox test message' });
    const ev = await inboxWritten;

    assert(typeof ev.file === 'string', 'Session bridge: inbox file path returned');

    // Verify the file exists and is valid JSON.
    const raw = await fs.readFile(ev.file, 'utf8');
    const entry = JSON.parse(raw);
    assert(entry.from === 'agent-a', 'Session bridge: inbox file has correct sender');
    assertEq(entry.type, 'notification', 'Session bridge: inbox file has correct type');
    assert(entry.receivedAt, 'Session bridge: inbox file has receivedAt timestamp');

    // Drain and verify consume works.
    const msgs = await sessionBridge.drainInbox();
    assert(msgs.length >= 1, 'Session bridge: drainInbox returns messages');
    assert(msgs[0].from === 'agent-a', 'Session bridge: drained message has correct sender');

    // After drain, inbox should be empty.
    const remaining = await sessionBridge.listInbox();
    assertEq(remaining.length, 0, 'Session bridge: inbox empty after drain');
  } catch (err) {
    assert(false, `Session bridge: ${err.message}`);
  } finally {
    if (sessionBridge) await sessionBridge.stop();
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  console.log('\n--- Shutting down hubs ---');
  hubA._shuttingDown = true;
  hubB._shuttingDown = true;

  if (hubA._heartbeatInterval) clearInterval(hubA._heartbeatInterval);
  if (hubB._heartbeatInterval) clearInterval(hubB._heartbeatInterval);

  for (const state of hubA.outboundPeers.values()) {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.ws) state.ws.terminate();
  }
  for (const state of hubB.outboundPeers.values()) {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.ws) state.ws.terminate();
  }
  for (const ws of hubA.inboundPeers.values()) ws.terminate();
  for (const ws of hubB.inboundPeers.values()) ws.terminate();

  await new Promise((r) => hubA.wss.close(r));
  await new Promise((r) => hubB.wss.close(r));
  await new Promise((r) => hubA.httpApi.close(r));
  await new Promise((r) => hubB.httpApi.close(r));

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log('\n==============================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('==============================\n');

  // Clean up test state dirs.
  try {
    await fs.rm(path.join(ROOT, 'state', 'test', TEST_RUN), { recursive: true, force: true });
    await fs.rm(path.join(ROOT, 'logs',  'test', TEST_RUN), { recursive: true, force: true });
  } catch { /* non-fatal */ }

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
