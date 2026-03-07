# Task: Build agent-pulse WebSocket Hub (Phase 1)

## What This Is
A real-time WebSocket messaging hub for AI agent fleets. Each agent runs this hub process which maintains persistent bidirectional WebSocket connections to all peer agents. Messages flow in sub-millisecond time instead of HTTP round-trips.

## Read First
- `docs/DESIGN.md` - Full architecture and protocol design

## What to Build

### 1. `src/hub.js` - The main WebSocket hub process (Node.js)

**WebSocket Server (port 18800):**
- Accept incoming WS connections from peer agents
- Authenticate on connect via bearer token (from config/agent-registry.json)
- Identity exchange: on connect, peers send `{"type":"identify","agent":"agent-name","token":"bearer-token"}`
- Reject unauthorized connections
- Track connected peers with their identity

**WebSocket Clients:**
- On startup, read `config/agent-registry.json` for peer list
- Attempt WS connection to each peer at `ws://<ip>:18800`
- Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- Send identity message on connect
- Heartbeat ping/pong every 30 seconds to keep connections alive

**Message Handling:**
- Messages use JSON format with this envelope:
```json
{
  "protocol": "pulse/1.0",
  "id": "msg_<uuid>",
  "conversationId": "conv_<id>",  
  "from": "agent-name",
  "to": "agent-name",
  "type": "request|response|notification|broadcast",
  "timestamp": "ISO-8601",
  "payload": {
    "subject": "...",
    "body": "..."
  }
}
```
- Route messages to the correct peer connection
- For broadcast messages (to="*"), fan out to all connected peers
- Log all messages to `logs/pulse-audit.jsonl`

**HTTP Fallback:**
- If WS connection to a peer is down, fall back to HTTP POST (using agent-mesh format)
- Track connection status per peer
- Emit events when peers connect/disconnect

**Local Event Bus:**
- EventEmitter for local subscribers
- When a message arrives via WS, emit on local bus
- CLI tools and bridges can subscribe to the bus via a local Unix socket or HTTP SSE endpoint

**REST API (port 18801):**
- `GET /status` - hub status, connected peers, latency stats
- `GET /peers` - list of peers with connection status
- `POST /send` - send a message (used by CLI tools)
- `GET /events` - SSE stream of all incoming messages (for dashboard/bridges)
- `GET /conversations/<id>` - conversation state
- `POST /conversations` - create a new conversation

### 2. `src/cli.js` - CLI wrapper

Simple CLI that calls the REST API:
- `pulse send <agent> <type> "<message>"` - send a message
- `pulse broadcast "<message>"` - broadcast to all
- `pulse status` - show hub status and connected peers
- `pulse peers` - list peers with latency
- `pulse conversations` - list active conversations

### 3. `config/agent-registry.json.example`

Example config (use generic agent names, NO real names/IPs):
```json
{
  "agent": "my-agent",
  "port": 18800,
  "apiPort": 18801,
  "peers": {
    "agent-a": { "ip": "192.168.1.10", "port": 18800, "token": "secret-a" },
    "agent-b": { "ip": "192.168.1.11", "port": 18800, "token": "secret-b" }
  },
  "groups": {
    "work": ["agent-a", "agent-b"],
    "all": ["agent-a", "agent-b"]
  }
}
```

### 4. `package.json`

Minimal dependencies:
- `ws` - WebSocket library
- `uuid` - Message ID generation
That's it. Keep it lean.

### 5. State Management

Conversation state stored in `state/conversations/<conv_id>.json`:
- Full round history
- Participant list
- Status (active, parked, complete, timeout)
- Park/resume metadata

### 6. Logging

All messages to `logs/pulse-audit.jsonl`, one JSON line per event:
```json
{"timestamp":"...","id":"msg_xxx","from":"a","to":"b","type":"request","conversationId":"conv_xxx","status":"delivered","latencyMs":2}
```

## Quality Requirements
- Clean, readable code with comments
- Proper error handling (connection failures, malformed messages, auth failures)
- Graceful shutdown (SIGTERM handler, close all connections)
- No real agent names, IPs, or identifying info in code or comments
- ESM modules (import/export, not require)
- Node.js 22+ compatible

## Testing
- Create `test/test-hub.js` that:
  1. Starts two hub instances on different ports
  2. Verifies they connect to each other
  3. Sends a message from hub A to hub B
  4. Verifies message received
  5. Tests broadcast
  6. Tests reconnect after disconnect
  7. Verifies audit log written

## Files to Create
- `package.json`
- `src/hub.js` (main hub process)
- `src/cli.js` (CLI tool)
- `config/agent-registry.json.example`
- `test/test-hub.js`
- `.gitignore` (node_modules, config/agent-registry.json, state/, logs/)
- `README.md` (brief, no real names/IPs)

## DO NOT
- Use real agent names (no ltdan, bayou, wesley, etc.)
- Include real IPs
- Use em dashes
- Add unnecessary dependencies
- Over-engineer - this is Phase 1, keep it clean and functional
