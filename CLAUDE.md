# CLAUDE.md -- ha-gatekeeper

## Project Overview

ha-gatekeeper is an MCP server for Home Assistant that implements the "LLM as an untrusted advisor" architecture. The LLM generates intent; a deterministic policy engine decides whether that intent is permitted. Every action is classified, authorised, logged, and auditable.

**Author:** Ant Newman (antjsnewman@outlook.com / github.com/antnewman)
**Licence:** MIT
**Language:** TypeScript (strict mode)
**Runtime:** Node.js >= 20
**MCP SDK:** @modelcontextprotocol/sdk (v1.x, Streamable HTTP transport)

## Key Commands

- `npm run build` -- TypeScript compilation
- `npm run dev` -- development mode with hot reload (tsx watch)
- `npm run lint` -- ESLint (strict TypeScript rules, zero warnings required)
- `npm run test` -- Vitest (all unit and integration tests)
- `npm run test:watch` -- Vitest in watch mode
- `npm start` -- run the compiled server

## Architecture

Four-layer design:

1. **MCP Server** (src/server/) -- tool registry, entity validator, request context
2. **Policy Engine** (src/policy/) -- tier resolver, rate limiter, range clamper, HITL confirmation
3. **Execution Engine** (src/execution/) -- HA WebSocket client, state capture, circuit breaker
4. **Observability** (src/observability/) -- SQLite audit log, Prometheus metrics, health check

Request flow: tool call -> entity validation -> tier resolution -> policy constraints -> execution -> state capture -> audit log.

## Verified Autonomy Layer Mapping

ha-gatekeeper implements four of the nine layers from "Verified Autonomy: A Field Guide to Engineering Trust in AI Systems" (Newman & Greene, 2026). This is not a coincidence -- the Field Guide's trust architecture informed the design of this server.

**Layer 03: Making Failures Visible.** The Field Guide introduces a third output category: results the system is suspicious of, separated from results it trusts, made visible to human reviewers. ha-gatekeeper implements this through entity validation with fuzzy matching. When a tool call targets a non-existent entity (a hallucination), the server does not silently reject it. It returns the rejection alongside a list of similar entity names, making the failure visible to the LLM so it can self-correct. The `ha_gatekeeper_entity_hallucinations_total` metric tracks these incidents over time.

**Layer 05: Deterministic Guardrails.** The Field Guide's central guardrail principle is: "The model proposes. The rule decides." ha-gatekeeper's policy engine is a direct implementation of this pattern. The four-tier system (Unrestricted, Logged, Confirmed, Prohibited) maps to the Field Guide's three-severity model (INFO, WARN, BLOCK) with an additional read-only tier. Every policy decision traces back to a specific tier assignment and rule, creating the audit trail the Field Guide requires.

**Layer 08: Cryptographic Audit Trails (partial).** The Field Guide argues that trust in regulated environments requires the ability to prove what the system knew and decided. ha-gatekeeper's SQLite audit log captures every decision with full context. The hash-chained integrity mechanism (each row includes a SHA-256 hash of the previous row) makes the audit trail tamper-evident -- any modification to a historical record breaks the chain.

**Layer 02: Outlier Detection as Hard Escalation (architectural pattern).** The Field Guide's OR condition -- outliers OR low confidence, each independently triggering escalation -- is echoed in ha-gatekeeper's circuit breaker design. Any single failure signal (consecutive API failures, timeout, entity hallucination spike) independently triggers protective action. The system fails safe by design.

For the full Field Guide, see: github.com/antnewman/verified-autonomy

## Project Structure

```
src/
  index.ts                     # Entry point
  logger.ts                    # Pino logger (use this, never console.log)
  config/
    schema.ts                  # Zod schema for config.yaml validation
    loader.ts                  # YAML loading + env var substitution
    defaults.ts                # Default config values
  server/
    mcp-server.ts              # McpServer setup and transport
    entity-validator.ts        # Fuzzy matching entity validation (Layer 03)
    tools/
      index.ts                 # Tool registry
      read-tools.ts            # get_entity_state, list_entities, etc.
      control-tools.ts         # turn_on, turn_off, toggle, set_value, etc.
      monitoring-tools.ts      # get_anomalies, get_policy_summary
      meta-tools.ts            # get_server_health
  policy/
    engine.ts                  # Policy evaluation orchestrator
    tier-resolver.ts           # Entity/action -> tier number
    rate-limiter.ts            # Per-entity sliding window
    range-clamper.ts           # Numeric value clamping
    confirmation.ts            # HITL confirmation flow
  execution/
    ha-client.ts               # HA WebSocket connection wrapper
    state-capture.ts           # Before/after state recording
    circuit-breaker.ts         # Three-state circuit breaker
  observability/
    audit-log.ts               # SQLite audit log
    metrics.ts                 # Prometheus metrics
    health.ts                  # Health check endpoint
  types/
    ha.ts                      # HA API types
    policy.ts                  # Policy engine types
    audit.ts                   # Audit log types
    tools.ts                   # Tool I/O types
tests/
  unit/                        # Mirrors src/ structure
  integration/                 # Full pipeline tests
  fixtures/                    # Test configs, mock entities
```

## Policy Tiers

| Tier | Name | Behaviour |
|------|------|-----------|
| 0 | Unrestricted | Execute immediately, no audit |
| 1 | Logged | Execute, write audit trail |
| 2 | Confirmed | Human approval required, range clamping |
| 3 | Prohibited | Blocked always, attempt logged |

Tier resolution order: entity overrides > tier entity lists > domain patterns > action patterns > default_tier (3).

## Coding Standards

- **British English** in all comments, docs, logs, and error messages
- **Conventional commits:** `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- **Git identity:** `user.name = "antnewman"`, `user.email = "antjsnewman@outlook.com"`
- **No Co-Authored-By lines** in commits
- **Feature branches only.** Never commit to main.
- **No `any` type** without an inline justification comment
- **No `console.log`** -- use `logger` from `src/logger.ts` (pino)
- **No empty catch blocks** -- log all errors with context
- **All public functions** must have JSDoc comments
- **`noUncheckedIndexedAccess: true`** is enabled -- every index access must be null-checked
- **`exactOptionalPropertyTypes: true`** is enabled -- do not pass `undefined` for optional properties
- **Tests required** for every new module before the task is complete

## Dependencies

Core: `@modelcontextprotocol/sdk`, `home-assistant-js-websocket`, `better-sqlite3`, `yaml`, `zod`, `prom-client`, `express`, `uuid`, `pino`

Dev: `typescript`, `vitest`, `tsx`, `eslint`, `typescript-eslint`, `@types/better-sqlite3`, `@types/express`

## Build Phases

The project is built incrementally. Each phase must pass all tests before proceeding:

1. **Foundation** (complete) -- scaffolding, config loader, logger, HA client
2. **Policy Engine** (complete) -- tier resolver, rate limiter, range clamper, policy orchestrator
3. **Observability** (complete) -- SQLite audit log, Prometheus metrics, health check
4. **MCP Server + Tools** (complete) -- server setup, all 14 tools, entity validator
5. **Execution + Circuit Breaker** (complete) -- state capture, circuit breaker, full pipeline
6. **HITL Confirmation** (complete) -- confirmation tokens, webhooks, notifications
7. **Docker + Documentation** (complete) -- Dockerfile, docker-compose, README, guides

## Definition of Done

Before any task is complete:

- All existing tests pass (`npm run test`)
- New tests written for new code
- TypeScript compiles with zero errors (`npm run build`)
- ESLint passes with zero warnings (`npm run lint`)
- No `any`, no `console.log`, no empty catch blocks
- No hardcoded secrets
- Conventional commit on a feature branch
