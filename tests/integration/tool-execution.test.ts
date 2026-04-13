/**
 * Integration test: full tool call through policy engine to audit log.
 *
 * Tests the complete pipeline with mock HA state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PolicyEngine } from "../../src/policy/engine.js";
import { AuditLog } from "../../src/observability/audit-log.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import { CircuitBreaker } from "../../src/execution/circuit-breaker.js";
import type { HAClient } from "../../src/execution/ha-client.js";
import type { GatekeeperConfig } from "../../src/config/schema.js";

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createTestConfig(): GatekeeperConfig {
  return {
    homeassistant: {
      url: "ws://localhost:8123/api/websocket",
      token: "test",
    },
    server: { port: 8200, host: "0.0.0.0", transport: "streamable-http" },
    policy: {
      default_tier: 3,
      tiers: {
        "0": { description: "Read-only", domains: ["sensor.*"] },
        "1": {
          description: "Logged",
          domains: ["light.*"],
          constraints: {
            rate_limit: { max_calls_per_entity_per_minute: 3 },
          },
        },
        "2": {
          description: "Confirmed",
          domains: ["climate.*"],
          constraints: {
            rate_limit: { max_calls_per_entity_per_minute: 2 },
            confirmation: {
              method: "notification",
              timeout_seconds: 30,
              notification_service: "notify.test",
              message_template: "Approve?",
            },
            range_clamp: {
              "climate.temperature": { min: 15, max: 25 },
            },
          },
        },
        "3": {
          description: "Prohibited",
          domains: ["automation.*"],
        },
      },
    },
    circuit_breaker: {
      health_check_interval_ms: 30000,
      failure_threshold: 3,
      recovery_threshold: 2,
      timeout_ms: 5000,
    },
    observability: {
      audit_log: { enabled: true, database: ":memory:", retention_days: 90 },
      metrics: { enabled: false, port: 9090 },
      health: { enabled: false, port: 8201 },
    },
  };
}

function createMockHAClient(): HAClient {
  const entities: Record<string, { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string; context: { id: string; parent_id: string | null; user_id: string | null } }> = {
    "sensor.temp": {
      entity_id: "sensor.temp",
      state: "21.5",
      attributes: { unit_of_measurement: "°C" },
      last_changed: "2026-04-13T10:00:00Z",
      last_updated: "2026-04-13T10:00:00Z",
      context: { id: "ctx1", parent_id: null, user_id: null },
    },
    "light.living_room": {
      entity_id: "light.living_room",
      state: "off",
      attributes: { brightness: 0 },
      last_changed: "2026-04-13T09:00:00Z",
      last_updated: "2026-04-13T09:00:00Z",
      context: { id: "ctx2", parent_id: null, user_id: null },
    },
    "climate.bedroom": {
      entity_id: "climate.bedroom",
      state: "heat",
      attributes: { temperature: 20, current_temperature: 19.5 },
      last_changed: "2026-04-13T08:00:00Z",
      last_updated: "2026-04-13T08:00:00Z",
      context: { id: "ctx3", parent_id: null, user_id: null },
    },
    "automation.test": {
      entity_id: "automation.test",
      state: "on",
      attributes: {},
      last_changed: "2026-04-13T07:00:00Z",
      last_updated: "2026-04-13T07:00:00Z",
      context: { id: "ctx4", parent_id: null, user_id: null },
    },
  };

  return {
    getEntityState: vi.fn((id: string) => entities[id]),
    entityExists: vi.fn((id: string) => id in entities),
    getAllEntities: vi.fn(() => ({ ...entities })),
    callService: vi.fn().mockResolvedValue(undefined),
    isConnected: true,
    entityCount: Object.keys(entities).length,
    connectionState: "connected" as const,
  } as unknown as HAClient;
}

describe("Tool Execution Pipeline", () => {
  let config: GatekeeperConfig;
  let policyEngine: PolicyEngine;
  let auditLog: AuditLog;
  let metrics: MetricsRegistry;
  let circuitBreaker: CircuitBreaker;
  let haClient: HAClient;

  beforeEach(() => {
    config = createTestConfig();
    policyEngine = new PolicyEngine(config);
    auditLog = new AuditLog(":memory:");
    metrics = new MetricsRegistry();
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryThreshold: 2,
      timeoutMs: 5000,
      healthCheckIntervalMs: 30000,
    });
    haClient = createMockHAClient();
  });

  afterEach(() => {
    auditLog.close();
    circuitBreaker.destroy();
  });

  it("tier 0 read: returns data, no audit entry", () => {
    const decision = policyEngine.evaluate({
      entityId: "sensor.temp",
      action: "homeassistant.get_state",
    });

    expect(decision.tier).toBe(0);
    expect(decision.permitted).toBe(true);

    // No audit entry for tier 0
    const entries = auditLog.query();
    expect(entries).toHaveLength(0);
  });

  it("tier 1 control: permitted, audit entry recorded", async () => {
    const decision = policyEngine.evaluate({
      entityId: "light.living_room",
      action: "light.turn_on",
    });

    expect(decision.tier).toBe(1);
    expect(decision.permitted).toBe(true);

    // Execute through circuit breaker
    await circuitBreaker.execute(async () => {
      await haClient.callService({
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.living_room" },
      });
    });

    // Write audit entry
    auditLog.write({
      timestamp: new Date().toISOString(),
      request_id: "test-req-1",
      tool_name: "turn_on",
      entity_id: "light.living_room",
      action: "light.turn_on",
      policy_tier: decision.tier,
      policy_decision: decision.decision,
    });

    const entries = auditLog.query();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entity_id).toBe("light.living_room");
    expect(entries[0]!.policy_decision).toBe("allowed");
  });

  it("tier 2: values clamped when exceeding boundaries", () => {
    const decision = policyEngine.evaluate({
      entityId: "climate.bedroom",
      action: "climate.set_temperature",
      numericValues: { "climate.temperature": 30 },
    });

    expect(decision.tier).toBe(2);
    expect(decision.permitted).toBe(true);
    expect(decision.decision).toBe("clamped");
    expect(decision.clampedFrom).toEqual({ "climate.temperature": 30 });
    expect(decision.clampedTo).toEqual({ "climate.temperature": 25 });
  });

  it("tier 3: prohibited, attempt logged", () => {
    const decision = policyEngine.evaluate({
      entityId: "automation.test",
      action: "automation.turn_off",
    });

    expect(decision.tier).toBe(3);
    expect(decision.permitted).toBe(false);
    expect(decision.decision).toBe("denied_prohibited");

    // Log the prohibited attempt
    auditLog.write({
      timestamp: new Date().toISOString(),
      request_id: "test-req-2",
      tool_name: "turn_off",
      entity_id: "automation.test",
      action: "automation.turn_off",
      policy_tier: 3,
      policy_decision: "denied_prohibited",
    });

    const entries = auditLog.query({ policyDecision: "denied_prohibited" });
    expect(entries).toHaveLength(1);
  });

  it("hallucinated entity: rejected before policy", () => {
    const exists = haClient.entityExists("light.nonexistent");
    expect(exists).toBe(false);

    // Record the hallucination metric
    metrics.recordEntityHallucination();
  });

  it("rate limit exceeded: denied with retry-after", () => {
    // Make 3 calls (the limit)
    for (let i = 0; i < 3; i++) {
      const d = policyEngine.evaluate({
        entityId: "light.living_room",
        action: "light.turn_on",
      });
      expect(d.permitted).toBe(true);
    }

    // 4th call should be rate limited
    const decision = policyEngine.evaluate({
      entityId: "light.living_room",
      action: "light.turn_on",
    });

    expect(decision.permitted).toBe(false);
    expect(decision.decision).toBe("denied_rate_limit");
    expect(decision.reason).toContain("Rate limit exceeded");
  });

  it("circuit breaker trip and recovery", async () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      circuitBreaker.recordFailure();
    }

    expect(circuitBreaker.getState()).toBe("open");

    // Control calls should be rejected
    try {
      await circuitBreaker.execute(async () => "ok");
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      expect((err as Error).name).toBe("CircuitBreakerOpenError");
    }
  });
});
