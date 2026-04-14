# ha-gatekeeper

**A reliability-first MCP server for Home Assistant.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

ha-gatekeeper implements the "LLM as an untrusted advisor" architecture for Home Assistant. The LLM generates intent; a deterministic policy engine decides whether that intent is permitted. Every action is classified, authorised, logged, and auditable.

If ha-gatekeeper crashes, Home Assistant continues to function normally. The LLM layer is additive, never load-bearing.

---

## Why This Exists

Existing Home Assistant MCP servers share a common flaw: the LLM's tool call is executed directly against Home Assistant with no intermediate authorisation layer.

| Problem | Existing servers | ha-gatekeeper |
|---|---|---|
| Hallucinated entity name | API call to non-existent or wrong entity | Rejected by entity validator before execution |
| No action classification | Reading a sensor and unlocking a door are treated identically | Four-tier policy: unrestricted, logged, confirmed, prohibited |
| No rate limiting | A confused model can rapid-fire actuations | Per-entity sliding window rate limiter |
| No audit trail | Cannot reconstruct what happened or why | Structured SQLite audit log with before/after state |
| No circuit breaker | Partially-formed commands may execute during degradation | Three-state circuit breaker isolates failures |
| Too many tools | 38-95+ tools increase LLM selection errors | Curated set of 14 tools organised by user intent |

---

## Architecture

```
                    MCP Client (Claude Desktop, etc.)
                                |
                         MCP Streamable HTTP
                                |
  +-----------------------------v------------------------------+
  |  Layer 1: MCP Server                                       |
  |  Tool Registry | Entity Validator | Request Context Builder |
  +------------------------------------------------------------+
  |  Layer 2: Policy Engine                                    |
  |  Tier Resolver | Rate Limiter | Range Clamper | HITL       |
  +------------------------------------------------------------+
  |  Layer 3: Execution Engine                                 |
  |  HA WebSocket Client | State Capture | Circuit Breaker     |
  +------------------------------------------------------------+
  |  Layer 4: Observability                                    |
  |  Audit Log (SQLite) | Metrics (Prometheus) | Health Check  |
  +------------------------------------------------------------+
                                |
                         WebSocket API
                                |
                       Home Assistant
```

See [docs/architecture.md](docs/architecture.md) for the full deep-dive.

---

## Features

### Four-Tier Policy Engine

| Tier | Name | Behaviour | Example |
|------|------|-----------|---------|
| 0 | Unrestricted | Execute immediately, no audit | `sensor.*`, `weather.*` |
| 1 | Logged | Execute and write full audit trail | `light.*`, `switch.*`, `media_player.*` |
| 2 | Confirmed | Human approval required before execution | `climate.*`, `lock.*`, `alarm_control_panel.*` |
| 3 | Prohibited | Deterministically blocked, always | `automation.*`, `script.*`, `homeassistant.restart` |

Entity-level overrides let you promote or demote specific devices regardless of their domain.

### Safety Controls

- **Rate limiting** -- per-entity sliding window (configurable calls per minute)
- **Range clamping** -- hard min/max boundaries on numeric values (e.g. thermostat temperature 15-25C)
- **Entity validation** -- every entity ID is checked against live HA state with fuzzy matching suggestions for typos
- **Circuit breaker** -- three-state (closed/open/half-open) protection against cascading failures

### Observability

- **Audit log** -- SQLite database with SHA-256 hash-chained entries for tamper-evident recording of every policy decision
- **Prometheus metrics** -- tool call counts, durations, circuit breaker state, denial rates
- **Health check endpoint** -- connection status, entity count, error rates, uptime

---

## Tools

ha-gatekeeper exposes 15 curated tools organised by intent:

| Category | Tool | Description |
|----------|------|-------------|
| **Read** | `get_entity_state` | Current state and attributes of one entity |
| | `list_entities` | List entities with domain/area/label filter |
| | `get_area_summary` | All devices and states in an area |
| | `get_home_summary` | High-level summary of the entire home |
| | `get_entity_history` | State history for an entity over a time range |
| **Control** | `turn_on` | Turn on a light, switch, fan, etc. |
| | `turn_off` | Turn off a light, switch, fan, etc. |
| | `toggle` | Toggle the state of a device |
| | `set_value` | Set brightness, temperature, volume, position |
| | `activate_scene` | Activate a predefined scene |
| | `send_command` | Domain-specific command (e.g. play media) |
| **Monitor** | `get_anomalies` | Analyse home state and report anomalies |
| | `get_policy_summary` | Current policy tiers and entity classifications |
| **Meta** | `get_server_health` | Health status, circuit breaker, error rates |
| | `verify_audit_integrity` | Verify the hash chain of the audit log |

---

## Quick Start

### Prerequisites

- Node.js >= 20
- A running Home Assistant instance
- A [long-lived access token](https://www.home-assistant.io/docs/authentication/#your-account-profile) from Home Assistant

### Docker (recommended)

Pull the pre-built image:

```bash
docker pull antnewman/ha-gatekeeper:latest
# or from GitHub Container Registry:
docker pull ghcr.io/antnewman/ha-gatekeeper:latest
```

Then run with Docker Compose:

```bash
git clone https://github.com/antnewman/ha-gatekeeper.git
cd ha-gatekeeper

# Create your configuration
cp config.example.yaml config.yaml
# Edit config.yaml with your HA URL and entity classifications

# Set your token
export HA_TOKEN="your-long-lived-access-token"

# Run (pulls the image or builds locally)
docker compose up -d
```

The server will be available at `http://localhost:8200`.

### Manual

```bash
git clone https://github.com/antnewman/ha-gatekeeper.git
cd ha-gatekeeper
npm install
npm run build

cp config.example.yaml config.yaml
# Edit config.yaml

export HA_TOKEN="your-long-lived-access-token"
npm start
```

See [docs/getting-started.md](docs/getting-started.md) for the full walkthrough including MCP client setup.

---

## Configuration

ha-gatekeeper is configured via a single `config.yaml` file. See [config.example.yaml](config.example.yaml) for a fully annotated example.

Key sections:
- **homeassistant** -- connection URL and authentication
- **server** -- port, transport, session mode
- **policy** -- tier definitions, domain/entity classification, constraints
- **circuit_breaker** -- failure thresholds and recovery
- **observability** -- audit log, metrics, and health check settings

See [docs/configuration.md](docs/configuration.md) for the full reference.

---

## Development

```bash
# Install dependencies
npm install

# Run in development mode (hot reload)
npm run dev

# Build
npm run build

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Lint
npm run lint
```

### Project Structure

```
src/
  index.ts                    # Entry point
  logger.ts                   # Pino logger
  config/                     # YAML config loader + Zod validation
  execution/                  # HA WebSocket client, state capture, circuit breaker
  policy/                     # Tier resolver, rate limiter, range clamper, HITL
  server/                     # MCP server setup and tool definitions
  observability/              # Audit log, Prometheus metrics, health check
  types/                      # TypeScript type definitions
tests/
  unit/                       # Unit tests (mirroring src/ structure)
  integration/                # End-to-end pipeline tests
  fixtures/                   # Test config, mock entities
```

---

## Verified Autonomy

ha-gatekeeper implements four layers from the [Verified Autonomy: A Field Guide to Engineering Trust in AI Systems](https://github.com/antnewman/verified-autonomy) nine-layer trust architecture. Layer 03 (Making Failures Visible) via entity validation with fuzzy matching that returns suggestions when the LLM hallucinates an entity name. Layer 05 (Deterministic Guardrails) via the four-tier policy engine where "the model proposes, the rule decides." Layer 08 (Cryptographic Audit Trails) via hash-chained audit logging where each row includes a SHA-256 hash of the previous row, making the trail tamper-evident. Layer 02 (Outlier Detection as Hard Escalation) via the circuit breaker where any single failure signal independently triggers protective action.

---

## Roadmap

These are not in scope for v1 but are planned for future releases:

- Multi-user support with per-user policy tiers
- Configuration hot-reload without restart
- Automation suggestion tools (suggest, not create)
- MCP OAuth 2.1 authentication
- Grafana dashboard template
- Home Assistant add-on packaging

---

## Disclaimer

This software controls physical devices. The authors accept no responsibility for any damage, injury, or loss arising from its use. Always verify your policy configuration before connecting to a production Home Assistant instance.

---

## Licence

[MIT](LICENSE)

---

Built by [Ant Newman](https://github.com/antnewman).
