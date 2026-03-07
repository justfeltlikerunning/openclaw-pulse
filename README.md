<p align="center">
  <img src="assets/banner.png" alt="openclaw-pulse banner" width="100%">
</p>

# ⚡ openclaw-pulse

**[OpenClaw](https://github.com/openclaw/openclaw)-specific integration for [agent-pulse](https://github.com/justfeltlikerunning/agent-pulse) — decentralized real-time messaging for OpenClaw agent fleets.**

This is the OpenClaw flavor of agent-pulse. It includes gateway bridge configuration, hook mappings, and deployment patterns tailored for OpenClaw multi-agent setups. For the generic, framework-agnostic version, see [agent-pulse](https://github.com/justfeltlikerunning/agent-pulse).

![License](https://img.shields.io/badge/license-MIT-green?style=flat-square) ![OpenClaw](https://img.shields.io/badge/OpenClaw-compatible-purple?style=flat-square) ![Protocol](https://img.shields.io/badge/protocol-pulse%2F2.0-cyan?style=flat-square)

## What's Different from agent-pulse?

| Feature | agent-pulse (generic) | openclaw-pulse (this repo) |
|---------|----------------------|---------------------------|
| Gateway bridge | Configurable via env vars | Pre-configured for OpenClaw `/hooks/pulsenet` |
| Reply routing | Template-based (`PULSE_REPLY_TEMPLATE`) | Uses `pulsenet-send.sh` with `--conv-id` |
| Context router | Generic tier classification | Integrated with OpenClaw session isolation |
| Config examples | Generic agent-a, agent-b | OpenClaw fleet patterns |
| Systemd service | Basic template | OpenClaw userspace service with `MemoryMax` |

## Quick Start (OpenClaw)

```bash
# On each OpenClaw agent node:
npm install

# Configure for your fleet
cp config/agent-registry.json.example config/agent-registry.json
# Edit with your agent name, peers, and tokens

# Set OpenClaw gateway integration
export GATEWAY_HOOK_URL="http://127.0.0.1:18789/hooks/pulsenet"
export GATEWAY_HOOK_TOKEN="your-openclaw-hook-token"

node src/hub.js
```

## OpenClaw Gateway Bridge

When an encrypted message arrives for this agent:

1. Hub decrypts the payload (X25519 + AES-256-GCM)
2. Forwards to the local OpenClaw gateway via `POST /hooks/pulsenet`
3. OpenClaw creates an isolated session per conversation (`hook:pulse:<conv-id>`)
4. Agent processes the message with full tool access
5. Agent replies via `pulsenet-send.sh` — response flows back through the mesh

### Hook Mapping (OpenClaw gateway config)

```json
{
  "match": { "path": "pulsenet" },
  "action": "agent",
  "name": "PulseNet-Chat",
  "messageTemplate": "[PulseNet conversation {{conversationId}}]\nFrom: {{sender}}\n\n{{message}}\n\n[REPLY INSTRUCTIONS: Reply via pulsenet-send.sh with --conv-id {{conversationId}}]",
  "deliver": false,
  "allowUnsafeExternalContent": true
}
```

## Context Router Integration

The PulseNet server integrates a hybrid rules engine + local LLM (Qwen3-0.6B) to classify dispatch tiers:

| Tier | What's Sent | Token Savings |
|------|------------|---------------|
| **T0** | Task only, zero history | ~95% |
| **T1** | Task + metadata + fetch URL | ~60% |
| **T2** | Full conversation history | Baseline |

Agents can override with `[T0]`, `[T1]`, or `[T2]` prefix.

## Systemd Service (OpenClaw userspace)

```ini
[Unit]
Description=agent-pulse WebSocket Hub (OpenClaw)
After=network.target openclaw-gateway.service

[Service]
Type=simple
WorkingDirectory=%h/agent-pulse
ExecStart=/usr/bin/node src/hub.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
MemoryMax=512M

[Install]
WantedBy=default.target
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PULSE_AGENT_NAME | hub | This agent's name in the mesh |
| PULSE_WS_PORT | 18800 | WebSocket server port |
| PULSE_API_PORT | 18801 | REST API port |
| GATEWAY_HOOK_URL | http://127.0.0.1:18789/hooks/pulsenet | OpenClaw gateway hook endpoint |
| GATEWAY_HOOK_TOKEN | | OpenClaw gateway auth token |
| PULSE_REPLY_TEMPLATE | | Reply instruction template injected into forwarded messages |

## Related Projects

- **[agent-pulse](https://github.com/justfeltlikerunning/agent-pulse)** — Generic version (framework-agnostic)
- **[PulseNet](https://github.com/justfeltlikerunning/pulsenet)** — Multi-agent chat UI
- **[OpenClaw](https://github.com/openclaw/openclaw)** — AI agent framework

## License

MIT
