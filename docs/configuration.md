# Configuration Reference

ha-gatekeeper is configured via a single YAML file, typically `config.yaml` in the project root. Environment variables can be referenced using `${VAR_NAME}` syntax.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HA_TOKEN` | Home Assistant long-lived access token | Required |
| `HA_SENTINEL_CONFIG` | Path to config YAML file | `./config.yaml` |
| `HA_SENTINEL_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` | `info` |
| `NODE_ENV` | Runtime environment | `production` |

---

## homeassistant

Connection settings for your Home Assistant instance.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | -- | WebSocket URL, e.g. `ws://homeassistant.local:8123/api/websocket` |
| `token` | string | Yes | -- | Long-lived access token. Use `${HA_TOKEN}` for env var substitution. |
| `reconnect_interval_ms` | integer | No | `5000` | Milliseconds between reconnection attempts. |
| `max_reconnect_attempts` | integer | No | `10` | Maximum consecutive reconnection attempts. |

```yaml
homeassistant:
  url: "ws://homeassistant.local:8123/api/websocket"
  token: "${HA_TOKEN}"
  reconnect_interval_ms: 5000
  max_reconnect_attempts: 10
```

---

## server

MCP server settings.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `port` | integer | Yes | -- | Port for the MCP transport. |
| `host` | string | Yes | -- | Bind address. Use `0.0.0.0` for all interfaces. |
| `transport` | string | Yes | -- | `"streamable-http"` or `"stdio"`. |
| `session_mode` | string | No | `"stateful"` | `"stateful"` or `"stateless"`. |

```yaml
server:
  port: 8200
  host: "0.0.0.0"
  transport: "streamable-http"
  session_mode: "stateful"
```

---

## policy

The policy section defines what the LLM is allowed to do. This is the core of ha-gatekeeper.

### Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `default_tier` | 0-3 | Yes | -- | Tier assigned to any entity/action not explicitly classified. Use `3` (prohibited) to fail closed. |

### tiers

Each tier is a numeric key (0-3) containing classification rules and constraints.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | Yes | Human-readable description of the tier's purpose. |
| `domains` | string[] | No | Domain patterns to include. Supports wildcards: `sensor.*`, `light.*`. |
| `entities` | string[] | No | Specific entity IDs to include in this tier. |
| `actions` | string[] | No | Specific service actions to include. Supports wildcards: `homeassistant.reload_*`. |
| `constraints` | object | No | Rate limits, confirmation, and range clamping rules. |

### Tier resolution order

When determining which tier applies to a given entity and action, ha-gatekeeper checks in this order:

1. `entity_overrides` for the specific entity ID
2. `tiers[n].entities` lists for the specific entity ID
3. `tiers[n].domains` for a matching domain pattern
4. `tiers[n].actions` for the specific action
5. `default_tier` (fallback)

The first match wins. Resolution is deterministic with no ambiguity.

### constraints.rate_limit

| Field | Type | Description |
|-------|------|-------------|
| `max_calls_per_entity_per_minute` | integer | Maximum tool calls per entity within a 60-second sliding window. |

```yaml
constraints:
  rate_limit:
    max_calls_per_entity_per_minute: 10
```

### constraints.confirmation

Required for Tier 2. Defines the human-in-the-loop approval flow.

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | `"notification"` (HA notification service) or `"webhook"` (external webhook). |
| `timeout_seconds` | integer | Seconds to wait for approval before auto-denying. |
| `notification_service` | string | HA notify service entity, e.g. `notify.mobile_app_ant`. |
| `message_template` | string | Message template. Supports `{{action}}` and `{{entity_id}}` placeholders. |

```yaml
constraints:
  confirmation:
    method: "notification"
    timeout_seconds: 30
    notification_service: "notify.mobile_app_ant"
    message_template: "ha-gatekeeper: LLM wants to {{action}} on {{entity_id}}. Approve?"
```

### constraints.range_clamp

Enforces hard min/max boundaries on numeric attributes. Keys are `domain.attribute` patterns.

| Field | Type | Description |
|-------|------|-------------|
| `min` | number | Minimum allowed value. Requests below this are clamped up. |
| `max` | number | Maximum allowed value. Requests above this are clamped down. |

```yaml
constraints:
  range_clamp:
    climate.temperature:
      min: 15
      max: 25
    climate.target_temp_high:
      min: 15
      max: 28
```

If the LLM requests a value outside the range, it is silently adjusted to the nearest boundary. Both the original and clamped values are recorded in the audit log.

### entity_overrides

A map of entity ID to tier number. Overrides take the highest priority in tier resolution.

```yaml
entity_overrides:
  light.nursery: 2           # Promote: requires confirmation
  switch.server_rack_pdu: 3  # Promote: prohibited
  climate.office: 1          # Demote: logged only, no confirmation
```

---

## Tier Assignment Guide

Use this guide to classify your entities:

### Tier 0 -- Unrestricted

Suitable for entities that are **read-only** or have **no physical effect**:

- `sensor.*` -- temperature, humidity, power usage, etc.
- `binary_sensor.*` -- door/window open/closed, motion detection
- `weather.*` -- weather forecasts
- `sun.*` -- sunrise/sunset times
- `person.*` -- presence detection

### Tier 1 -- Logged

Suitable for entities that are **reversible** and **non-critical**:

- `light.*` -- lights can always be turned back off
- `switch.*` -- non-critical switches (exclude anything wired to critical systems)
- `media_player.*` -- play/pause/volume
- `fan.*` -- fans
- `cover.*` -- blinds, curtains, garage doors (consider Tier 2 for garage doors)
- `scene.*` -- activating predefined scenes
- `input_boolean.*` -- helper toggles
- `input_number.*` -- helper sliders

### Tier 2 -- Confirmed

Suitable for entities with **safety, security, or comfort implications**:

- `climate.*` -- thermostats (use range clamping to set boundaries)
- `lock.*` -- door locks
- `alarm_control_panel.*` -- alarm systems
- `valve.*` -- water/gas valves
- `humidifier.*` -- humidifiers/dehumidifiers

Also promote individual Tier 1 entities that need extra protection:

- `light.nursery` -- baby's room
- `cover.garage_door` -- physical access point

### Tier 3 -- Prohibited

Suitable for entities that the LLM **must never control**:

- `automation.*` -- HA automations (modifying these could break your setup)
- `script.*` -- HA scripts (may have destructive side effects)
- `input_button.*` -- often wired to trigger complex actions
- `homeassistant.restart` -- system restart
- `homeassistant.reload_*` -- configuration reload
- `backup.*` -- backup operations

Also promote individual entities that are too critical for LLM control:

- `switch.garage_door_relay` -- direct relay control
- `lock.front_door` -- primary entry point
- `switch.server_rack_pdu` -- server power

---

## circuit_breaker

Protects against cascading failures when the Home Assistant connection degrades.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `health_check_interval_ms` | integer | Yes | -- | Milliseconds between health checks when the circuit is open. |
| `failure_threshold` | integer | Yes | -- | Consecutive HA API failures to trip the circuit breaker. |
| `recovery_threshold` | integer | Yes | -- | Consecutive successes to reset from half-open to closed. |
| `timeout_ms` | integer | Yes | -- | Maximum time in milliseconds for any HA API call. |

```yaml
circuit_breaker:
  health_check_interval_ms: 30000
  failure_threshold: 3
  recovery_threshold: 5
  timeout_ms: 10000
```

---

## observability

### audit_log

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Whether to write audit log entries. |
| `database` | string | Yes | Path to the SQLite database file. |
| `retention_days` | integer | Yes | Days to retain audit entries before cleanup. |

### metrics

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Whether to expose Prometheus metrics. |
| `port` | integer | Yes | Port for the Prometheus scrape endpoint (`GET /metrics`). |

### health

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Whether to expose the health check endpoint. |
| `port` | integer | Yes | Port for the health check endpoint (`GET /health`). |

```yaml
observability:
  audit_log:
    enabled: true
    database: "./data/audit.db"
    retention_days: 90
  metrics:
    enabled: true
    port: 9090
  health:
    enabled: true
    port: 8201
```

---

## Full Example

See [config.example.yaml](../config.example.yaml) for a complete annotated configuration file.
