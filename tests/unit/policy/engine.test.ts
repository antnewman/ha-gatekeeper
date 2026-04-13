import { describe, it, expect, beforeEach } from "vitest";
import { PolicyEngine } from "../../../src/policy/engine.js";
import type { GatekeeperConfig } from "../../../src/config/schema.js";

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
        "0": {
          description: "Read-only",
          domains: ["sensor.*", "binary_sensor.*"],
        },
        "1": {
          description: "Logged",
          domains: ["light.*", "switch.*"],
          constraints: {
            rate_limit: { max_calls_per_entity_per_minute: 5 },
          },
        },
        "2": {
          description: "Confirmed",
          domains: ["climate.*", "lock.*"],
          constraints: {
            rate_limit: { max_calls_per_entity_per_minute: 3 },
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
          domains: ["automation.*", "script.*"],
        },
      },
      entity_overrides: {
        "light.nursery": 2,
      },
    },
    circuit_breaker: {
      health_check_interval_ms: 30000,
      failure_threshold: 3,
      recovery_threshold: 5,
      timeout_ms: 10000,
    },
    observability: {
      audit_log: { enabled: true, database: ":memory:", retention_days: 90 },
      metrics: { enabled: false, port: 9090 },
      health: { enabled: false, port: 8201 },
    },
  };
}

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine(createTestConfig());
  });

  describe("tier 0 (unrestricted)", () => {
    it("allows read-only entities immediately", () => {
      const decision = engine.evaluate({ entityId: "sensor.temperature" });
      expect(decision.tier).toBe(0);
      expect(decision.permitted).toBe(true);
      expect(decision.decision).toBe("allowed");
    });
  });

  describe("tier 1 (logged)", () => {
    it("allows logged entities", () => {
      const decision = engine.evaluate({ entityId: "light.living_room" });
      expect(decision.tier).toBe(1);
      expect(decision.permitted).toBe(true);
      expect(decision.decision).toBe("allowed");
    });

    it("rate limits after exceeding calls per minute", () => {
      for (let i = 0; i < 5; i++) {
        engine.evaluate({ entityId: "light.living_room" });
      }

      const decision = engine.evaluate({ entityId: "light.living_room" });
      expect(decision.tier).toBe(1);
      expect(decision.permitted).toBe(false);
      expect(decision.decision).toBe("denied_rate_limit");
    });
  });

  describe("tier 2 (confirmed)", () => {
    it("allows confirmed entities (confirmation handled by caller)", () => {
      const decision = engine.evaluate({ entityId: "climate.bedroom" });
      expect(decision.tier).toBe(2);
      expect(decision.permitted).toBe(true);
      expect(decision.decision).toBe("allowed");
    });

    it("clamps numeric values that exceed boundaries", () => {
      const decision = engine.evaluate({
        entityId: "climate.bedroom",
        numericValues: { "climate.temperature": 30 },
      });

      expect(decision.tier).toBe(2);
      expect(decision.permitted).toBe(true);
      expect(decision.decision).toBe("clamped");
      expect(decision.clampedFrom).toEqual({ "climate.temperature": 30 });
      expect(decision.clampedTo).toEqual({ "climate.temperature": 25 });
    });

    it("does not clamp values within range", () => {
      const decision = engine.evaluate({
        entityId: "climate.bedroom",
        numericValues: { "climate.temperature": 20 },
      });

      expect(decision.tier).toBe(2);
      expect(decision.permitted).toBe(true);
      expect(decision.decision).toBe("allowed");
      expect(decision.clampedFrom).toBeUndefined();
    });

    it("rate limits tier 2 entities", () => {
      for (let i = 0; i < 3; i++) {
        engine.evaluate({ entityId: "climate.bedroom" });
      }

      const decision = engine.evaluate({ entityId: "climate.bedroom" });
      expect(decision.permitted).toBe(false);
      expect(decision.decision).toBe("denied_rate_limit");
    });

    it("applies override to promote entity to tier 2", () => {
      const decision = engine.evaluate({ entityId: "light.nursery" });
      expect(decision.tier).toBe(2);
      expect(decision.permitted).toBe(true);
    });
  });

  describe("tier 3 (prohibited)", () => {
    it("denies prohibited entities", () => {
      const decision = engine.evaluate({ entityId: "automation.test" });
      expect(decision.tier).toBe(3);
      expect(decision.permitted).toBe(false);
      expect(decision.decision).toBe("denied_prohibited");
      expect(decision.reason).toContain("Tier 3");
      expect(decision.reason).toContain("Prohibited");
    });

    it("denies unclassified entities (default tier 3)", () => {
      const decision = engine.evaluate({ entityId: "unknown.entity" });
      expect(decision.tier).toBe(3);
      expect(decision.permitted).toBe(false);
      expect(decision.decision).toBe("denied_prohibited");
    });
  });

  describe("rate limit reset", () => {
    it("resetRateLimits clears all rate limit state", () => {
      for (let i = 0; i < 5; i++) {
        engine.evaluate({ entityId: "light.living_room" });
      }

      expect(
        engine.evaluate({ entityId: "light.living_room" }).permitted,
      ).toBe(false);

      engine.resetRateLimits();

      expect(
        engine.evaluate({ entityId: "light.living_room" }).permitted,
      ).toBe(true);
    });
  });
});
