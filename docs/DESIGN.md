# MESH v4 - Real-Time Agent Conversations

## Problem Statement

MESH v3 conversations are request-response: fire a message, wait for a reply, manually check if it arrived. Agents can't go back and forth in real-time. The coordinator (hub) doesn't get notified when responses arrive in their active session. The dashboard sees responses before the orchestrating agent does.

This is a fundamental limitation of HTTP POST webhooks: every message is a separate request, creates a separate session on the receiver, and the sender has no push notification when a response comes back.

As LLMs get faster (sub-second response times), the communication layer between agents needs to keep up. HTTP round-trips add latency that dominates the actual thinking time.

## Goals

1. **Real-time bidirectional messaging** between agents (sub-second delivery)
2. **Persistent conversations** where agents go back and forth until agreement
3. **In-session awareness** - active sessions get notified immediately when messages arrive
4. **Park and resume** - table a conversation, set a cron, pick it up later in the same thread
5. **Agent-to-agent direct** - agents talk to each other without routing through coordinator
6. **Framework-agnostic** - works with OpenClaw but also any agent framework
7. **Backward compatible** - HTTP POST still works as fallback

## Protocol Evaluation

| Protocol | Latency | Direction | Persistent | Complexity | Verdict |
|----------|---------|-----------|------------|------------|---------|
| HTTP POST (current) | 50-100ms/msg | One-way | No | Low | Fallback only |
| SSE | ~10ms | Server->client only | Yes | Low | Notifications only |
| WebSocket | <1ms once connected | Bidirectional | Yes | Medium | **Primary for v4** |
| gRPC streaming | <1ms | Bidirectional | Yes | High | Overkill for now |
| NATS/Redis pub-sub | <1ms | Bidirectional | Yes | High (external dep) | Future option |

**Decision: WebSocket as primary, HTTP POST as fallback.**

## Architecture

### Dual-Stack Communication

```
Agent A                                Agent B
+------------------+                   +------------------+
|  OpenClaw        |                   |  OpenClaw        |
|  Gateway :18789  |                   |  Gateway :18789  |
+--------+---------+                   +--------+---------+
         |                                      |
+--------+---------+    WebSocket     +--------+---------+
|  MESH Hub        | <=============>  |  MESH Hub        |
|  :18800          |   persistent     |  :18800          |
|                  |   bidirectional  |                  |
|  - WS server     |                  |  - WS server     |
|  - WS clients    |                  |  - WS clients    |
|  - Event bus     |                  |  - Event bus     |
|  - Conv state    |                  |  - Conv state    |
+------------------+                  +------------------+
         |                                      |
    HTTP POST                              HTTP POST
    (fallback)                             (fallback)
```

### MESH Hub Process

Each agent runs a lightweight `mesh-hub` process (Node.js or Python):
- **WebSocket server** on port 18800 (configurable)
- **WebSocket clients** connecting to all known peers
- **Local event bus** that bridges WS messages to OpenClaw sessions
- **Conversation state manager** with persistent storage
- **HTTP fallback** when WS connection is down

### Connection Lifecycle

```
1. Agent starts -> mesh-hub starts
2. mesh-hub reads agent-registry.json
3. For each peer: attempt WebSocket connection to peer:18800
4. On connect: exchange identity + capabilities
5. Connection stays open - heartbeat ping/pong every 30s
6. Messages flow bidirectionally with sub-ms latency
7. On disconnect: auto-reconnect with exponential backoff
8. If reconnect fails after 30s: fall back to HTTP POST
9. When WS reconnects: resume from last message sequence
```

### Message Flow (Real-Time Conversation)

```
Coordinator                Agent-A                 Agent-B
     |                        |                        |
     |--[WS] "Count records"->|                        |
     |--[WS] "Count records"->+---------------------->|
     |                        |                        |
     |                        |<--[WS] "Found 897"-----|
     |<--[WS] "Found 897"----|                        |
     |                        |                        |
     |<--[WS] "I got 897 too"|                        |
     |                        |                        |
     | (both agree, auto-close conversation)           |
     |                        |                        |
```

All messages in same conversation thread. All participants see all messages in real-time. No polling. No manual checks.

### In-Session Notification Bridge

The key innovation: mesh-hub bridges incoming WS messages to the active OpenClaw session.

**Option A: File-based bridge (framework-agnostic)**
```
1. WS message arrives at mesh-hub
2. mesh-hub writes to state/inbox/<conversation_id>.jsonl
3. OpenClaw agent checks inbox on each turn (or via heartbeat)
4. Agent sees new message, responds in context
```

**Option B: System event injection (OpenClaw-specific, needs fork)**
```
1. WS message arrives at mesh-hub
2. mesh-hub calls OpenClaw internal API to inject system event
3. Active session receives event immediately
4. Agent sees it mid-conversation without polling
```

**Option C: Hook with session routing (current OpenClaw, no changes)**
```
1. WS message arrives at mesh-hub
2. mesh-hub POSTs to localhost /hooks/agent with sessionKey
3. OpenClaw routes to the correct session
4. Still creates a new turn but in the RIGHT session
```

**Approach: Start with Option C (works today), build toward Option B (fork).**

## Conversation Threading v2

### Multi-Turn Flow

```json
{
  "conversationId": "conv_abc123",
  "type": "collab",
  "participants": ["coordinator", "agent-a", "agent-b"],
  "status": "active",
  "rounds": [
    {
      "round": 1,
      "from": "coordinator",
      "message": "Count active records in district X",
      "timestamp": "2026-02-27T06:00:00Z"
    },
    {
      "round": 2,
      "from": "agent-a",
      "message": "Found 897 using method A",
      "timestamp": "2026-02-27T06:00:03Z"
    },
    {
      "round": 3,
      "from": "agent-b",
      "message": "I got 897 too using method B. We agree.",
      "timestamp": "2026-02-27T06:00:05Z"
    },
    {
      "round": 4,
      "from": "coordinator",
      "verdict": "confirmed",
      "message": "Both agree at 897. Closing.",
      "timestamp": "2026-02-27T06:00:06Z"
    }
  ],
  "verdict": "confirmed",
  "closedAt": "2026-02-27T06:00:06Z"
}
```

### Park and Resume

```json
{
  "conversationId": "conv_abc123",
  "status": "parked",
  "parkedAt": "2026-02-27T06:00:10Z",
  "resumeAt": "2026-03-13T06:00:00Z",
  "resumeReason": "Need next month's production data",
  "resumeCron": "mesh-conversation.sh resume conv_abc123"
}
```

When the cron fires, it reopens the conversation with full context from previous rounds. Agents pick up where they left off.

### Agent-to-Agent Direct Conversations

Agents can initiate conversations with each other without coordinator involvement:

```bash
# On agent-a: start a collab with agent-b
mesh-converse.sh collab agent-b "I found an anomaly in the sampling data. \
  Can you cross-reference?"
```

Agent-b receives the message in real-time via WebSocket, sees agent-a's context, and responds directly. The coordinator gets notified (cc'd) but doesn't need to relay.

## Implementation Phases

### Phase 1: WebSocket Layer (foundation)
- mesh-hub process (Node.js, single file)
- WS server on port 18800
- WS client connections to all peers
- Auto-reconnect with backoff
- Identity exchange on connect
- Heartbeat ping/pong
- Message serialization (JSON, same envelope format)
- HTTP POST fallback when WS is down
- systemd service unit

### Phase 2: Conversation Threading v2
- Multi-turn conversation state with full round history
- All participants see all messages via WS broadcast
- Park/resume with cron scheduling
- Auto-consensus detection (configurable)
- Conversation timeout handling

### Phase 3: In-Session Bridge
- Option C first: hook with sessionKey routing
- File-based inbox as framework-agnostic alternative
- Test with OpenClaw active sessions
- Evaluate: does Option C give fast enough awareness?

### Phase 4: OpenClaw Integration (fork)
- Fork openclaw/openclaw
- Add system event injection API
- mesh-hub uses injection for real-time in-session notification
- Submit PR upstream with production evidence

### Phase 5: Advanced Features
- Message priority levels (urgent interrupts, normal queues)
- Conversation templates (pre-defined flows)
- Agent capability advertisement (what can each agent do?)
- Load balancing (route to least-busy agent with matching capability)
- End-to-end encryption over WebSocket
- Conversation replay/debug tools

## Port Allocation

| Service | Port | Purpose |
|---------|------|---------|
| OpenClaw Gateway | 18789 | Existing - HTTP hooks, API |
| MESH Hub WS | 18800 | New - WebSocket server |
| MESH Hub API | 18801 | New - Local REST API for CLI tools |
| Dashboard | 8880 | Existing - Web UI + SSE |
| Memory API | 8850 | Existing - Agent memory HTTP |

## Security

- WebSocket connections authenticated via token exchange on connect
- Same bearer tokens from agent-registry.json
- HMAC signing on WS messages (same as HTTP)
- TLS upgrade for cloud deployments (wss://)
- Connection rate limiting (prevent reconnect storms)

## Backward Compatibility

- All existing mesh-send.sh / mesh-rally.sh commands continue to work
- HTTP POST is always available as fallback
- Agents without mesh-hub still receive messages via hooks
- Conversation state format is additive (new fields, no breaking changes)
- Existing conversation types all supported

## Dependencies

- Node.js `ws` package (or Python `websockets`) for WS implementation
- Everything else: bash, jq, curl (same as v3)
- No external message broker needed

## Success Criteria

1. Agent-to-agent message delivery in <100ms (vs current 50-100ms + session wake time)
2. Multi-turn conversation with 5+ rounds, all participants seeing all messages
3. Park a conversation, resume it 24h later with full context
4. Coordinator sees responses in active session without manual checking
5. Zero message loss during normal operation
6. Graceful degradation to HTTP when WS is down
