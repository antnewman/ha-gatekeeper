# Architecture

ha-gatekeeper uses a four-layer architecture that interposes a deterministic policy engine between the LLM's intent and Home Assistant's execution layer.

---

## Design Principle

**The LLM generates intent; a deterministic policy engine decides whether that intent is permitted.**

This means:

- The LLM never talks directly to Home Assistant.
- Every action is classified, authorised, and logged before execution.
- If ha-gatekeeper crashes, Home Assistant continues to function normally.
- The LLM layer is additive, never load-bearing.

---

## Four-Layer Design

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

### Layer 1: MCP Server

Receives tool calls from the MCP client, validates inputs, and routes them through the pipeline.

- **Tool Registry** -- 14 curated tools organised by user intent (read, control, monitor, meta). Each tool has a Zod input schema and MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- **Entity Validator** -- checks every entity ID against live HA state before any further processing. Rejects hallucinated or non-existent entities with a clear error.
- **Request Context Builder** -- enriches the tool call with a unique request ID, timestamp, and resolved entity metadata.

### Layer 2: Policy Engine

Evaluates whether the tool call is permitted and applies any constraints.

- **Tier Resolver** -- maps entity ID + action to a policy tier (0-3) using the configured resolution order.
- **Rate Limiter** -- per-entity sliding window. Rejects calls exceeding the configured rate.
- **Range Clamper** -- enforces hard min/max on numeric values. Adjusts silently, logs the adjustment.
- **HITL Confirmation** -- for Tier 2 actions, sends a notification and waits for human approval.

### Layer 3: Execution Engine

Executes the authorised action against Home Assistant.

- **HA WebSocket Client** -- persistent WebSocket connection using `home-assistant-js-websocket`. Maintains a real-time entity state cache via `subscribeEntities`.
- **State Capture** -- records entity state before execution and after a 500ms settling delay (accounting for Zigbee/Z-Wave devices that report state changes asynchronously).
- **Circuit Breaker** -- three-state protection (closed/open/half-open) that isolates failures and prevents cascading errors.

### Layer 4: Observability

Records everything for auditing and monitoring.

- **Audit Log** -- SQLite database with full context: tool name, entity ID, tier, decision, before/after state, execution duration, and any errors.
- **Prometheus Metrics** -- counters, histograms, and gauges for tool calls, durations, denials, circuit breaker state, and connection health.
- **Health Check** -- HTTP endpoint reporting overall system health, circuit breaker state, HA connectivity, and error rates.

---

## Request Flow

A complete tool call flows through the system as follows:

```
1. MCP client sends tool call (e.g. turn_on, entity_id: light.living_room)
        |
2. Entity Validator: Does light.living_room exist in HA state?
   - No  --> Return error: "Entity not found"
   - Yes --> Continue
        |
3. Tier Resolver: What tier is light.living_room?
   - Check entity_overrides --> not found
   - Check tier entity lists --> not found
   - Check tier domains --> matches light.* in Tier 1
   - Result: Tier 1
        |
4. Policy evaluation based on tier:
   - Tier 0: Execute immediately
   - Tier 1: Check rate limit --> Execute --> Audit log
   - Tier 2: Check rate limit --> Clamp values --> Request confirmation --> Execute --> Audit log
   - Tier 3: Audit log --> Return "prohibited" error
        |
5. Rate Limiter: Has light.living_room exceeded 10 calls/minute?
   - Yes --> Return rate limit error with retry-after
   - No  --> Continue
        |
6. State Capture: Record current state of light.living_room
        |
7. Execution: Call light.turn_on via HA WebSocket
        |
8. Circuit Breaker: Did the call succeed?
   - Yes --> Reset failure counter
   - No  --> Increment failure counter, check threshold
        |
9. State Capture: Wait 500ms, record new state of light.living_room
        |
10. Audit Log: Write entry with full context
        |
11. Return result to MCP client
```

---

## Policy Engine Detail

### Tier Resolution Order

The tier resolver checks these sources in priority order. The first match wins:

1. **entity_overrides** -- explicit entity-to-tier mapping (highest priority)
2. **tiers[n].entities** -- entity IDs listed within a specific tier
3. **tiers[n].domains** -- domain wildcard patterns (e.g. `light.*`)
4. **tiers[n].actions** -- action/service patterns (e.g. `homeassistant.restart`)
5. **default_tier** -- fallback (lowest priority, default: 3 = prohibited)

This order ensures that specific entity overrides always take precedence over broad domain rules.

### Tier Behaviours

| Tier | Rate limit | Range clamp | Confirmation | Audit log | Execution |
|------|-----------|-------------|-------------|-----------|-----------|
| 0 | No | No | No | No | Yes |
| 1 | Yes | No | No | Yes | Yes |
| 2 | Yes | Yes | Yes | Yes | If approved |
| 3 | No | No | No | Yes (attempt) | Never |

---

## Circuit Breaker State Machine

```
                    success
    +--------+  (reset counter)  +--------+
    |        | <---------------- |        |
    | CLOSED |                   | CLOSED |
    |        | ----------------> |        |
    +--------+    failure        +--------+
                  (increment)
         |
         | failure_threshold reached
         v
    +--------+
    |  OPEN  |  All control calls rejected.
    |        |  Read calls may still function.
    +--------+
         |
         | health_check_interval elapsed, health check succeeds
         v
    +-----------+
    | HALF_OPEN |  Limited requests allowed through.
    +-----------+
       |      |
       |      | any failure --> back to OPEN
       |
       | recovery_threshold consecutive successes
       v
    +--------+
    | CLOSED |  Normal operation resumed.
    +--------+
```

- **CLOSED** (normal): all requests flow through. Failures increment a counter. Any success resets it.
- **OPEN** (tripped): control tool calls return a circuit breaker error. The system periodically attempts a health check (`get_config` call).
- **HALF_OPEN** (testing): a limited number of requests pass through. Consecutive successes close the breaker. Any failure reopens it.

---

## Audit Log Schema

Every Tier 1+ action (and all Tier 3 attempts) is recorded in a SQLite database:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `timestamp` | TEXT | ISO 8601 timestamp |
| `request_id` | TEXT | UUID correlating with the MCP request |
| `tool_name` | TEXT | Name of the MCP tool called |
| `entity_id` | TEXT | Target entity, if applicable |
| `action` | TEXT | HA service action |
| `parameters` | TEXT | JSON-serialised tool call parameters |
| `policy_tier` | INTEGER | Resolved tier (0-3) |
| `policy_decision` | TEXT | Outcome: allowed, denied_rate_limit, denied_prohibited, denied_timeout, confirmed, clamped |
| `clamped_from` | TEXT | JSON: original values before clamping |
| `clamped_to` | TEXT | JSON: adjusted values after clamping |
| `state_before` | TEXT | JSON: entity state before execution |
| `state_after` | TEXT | JSON: entity state after execution |
| `execution_duration_ms` | INTEGER | Time taken for the HA API call |
| `error` | TEXT | Error message if execution failed |
| `llm_rationale` | TEXT | Natural language rationale from the LLM |

Retention is configurable (default: 90 days). A daily cleanup job removes entries older than the retention period.

---

## Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `ha_gatekeeper_tool_calls_total` | counter | tool, tier, decision | Total tool calls |
| `ha_gatekeeper_tool_call_duration_seconds` | histogram | tool | Tool call latency |
| `ha_gatekeeper_circuit_breaker_state` | gauge | -- | 0=closed, 1=half_open, 2=open |
| `ha_gatekeeper_rate_limit_rejections_total` | counter | entity_id | Rate limit rejections |
| `ha_gatekeeper_entity_hallucinations_total` | counter | -- | Calls to non-existent entities |
| `ha_gatekeeper_confirmation_timeouts_total` | counter | -- | Tier 2 confirmation timeouts |
| `ha_gatekeeper_ha_connection_state` | gauge | -- | 0=disconnected, 1=connected |
| `ha_gatekeeper_policy_denials_total` | counter | tier, reason | Policy denials |

---

## Health Check

`GET /health` returns:

```json
{
  "status": "healthy",
  "circuit_breaker": "closed",
  "ha_connected": true,
  "ha_entity_count": 147,
  "uptime_seconds": 86400,
  "last_tool_call": "2026-04-13T10:30:00Z",
  "error_rate_1h": 0.02,
  "version": "0.1.0"
}
```

| Status | Condition |
|--------|-----------|
| `healthy` | Circuit breaker closed and HA connected |
| `degraded` | Circuit breaker half-open |
| `unhealthy` | Circuit breaker open or HA disconnected |
