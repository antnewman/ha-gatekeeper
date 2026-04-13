import { describe, it, expect } from "vitest";
import { resolveTier } from "../../../src/policy/tier-resolver.js";
import type { GatekeeperConfig } from "../../../src/config/schema.js";

/** Minimal config for testing tier resolution. */
function createTestConfig(
  overrides?: Partial<GatekeeperConfig["policy"]>,
): GatekeeperConfig {
  return {
    homeassistant: {
      url: "ws://localhost:8123/api/websocket",
      token: "test",
    },
    server: {
      port: 8200,
      host: "0.0.0.0",
      transport: "streamable-http",
    },
    policy: {
      default_tier: 3,
      tiers: {
        "0": {
          description: "Read-only",
          domains: ["sensor.*", "binary_sensor.*"],
          actions: [
            "homeassistant.get_state",
            "homeassistant.get_states",
          ],
        },
        "1": {
          description: "Logged",
          domains: ["light.*", "switch.*", "media_player.*"],
        },
        "2": {
          description: "Confirmed",
          domains: ["climate.*", "lock.*"],
        },
        "3": {
          description: "Prohibited",
          domains: ["automation.*", "script.*"],
          entities: ["switch.dangerous", "lock.front_door"],
          actions: ["homeassistant.restart", "homeassistant.reload_*"],
        },
      },
      entity_overrides: {
        "light.nursery": 2,
        "climate.office": 1,
        "switch.server_rack_pdu": 3,
      },
      ...overrides,
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

describe("resolveTier", () => {
  const config = createTestConfig();

  describe("entity overrides (priority 1)", () => {
    it("returns the override tier for a specifically overridden entity", () => {
      expect(resolveTier("light.nursery", undefined, config)).toBe(2);
    });

    it("override beats domain rule", () => {
      // climate.office would be tier 2 via climate.* domain, but is overridden to 1
      expect(resolveTier("climate.office", undefined, config)).toBe(1);
    });

    it("override can promote to tier 3", () => {
      expect(resolveTier("switch.server_rack_pdu", undefined, config)).toBe(3);
    });
  });

  describe("tier entity lists (priority 2)", () => {
    it("matches entity explicitly listed in a tier", () => {
      expect(resolveTier("switch.dangerous", undefined, config)).toBe(3);
    });

    it("entity list beats domain match", () => {
      // lock.front_door is in tier 3 entities, even though lock.* is tier 2
      expect(resolveTier("lock.front_door", undefined, config)).toBe(3);
    });
  });

  describe("domain patterns (priority 3)", () => {
    it("matches sensor.* to tier 0", () => {
      expect(resolveTier("sensor.temperature", undefined, config)).toBe(0);
    });

    it("matches binary_sensor.* to tier 0", () => {
      expect(resolveTier("binary_sensor.motion", undefined, config)).toBe(0);
    });

    it("matches light.* to tier 1", () => {
      expect(resolveTier("light.living_room", undefined, config)).toBe(1);
    });

    it("matches switch.* to tier 1", () => {
      expect(resolveTier("switch.desk_lamp", undefined, config)).toBe(1);
    });

    it("matches climate.* to tier 2", () => {
      expect(resolveTier("climate.bedroom", undefined, config)).toBe(2);
    });

    it("matches lock.* to tier 2", () => {
      expect(resolveTier("lock.back_door", undefined, config)).toBe(2);
    });

    it("matches automation.* to tier 3", () => {
      expect(resolveTier("automation.morning", undefined, config)).toBe(3);
    });

    it("matches script.* to tier 3", () => {
      expect(resolveTier("script.reboot_server", undefined, config)).toBe(3);
    });
  });

  describe("action patterns (priority 4)", () => {
    it("matches exact action", () => {
      expect(resolveTier("unknown.entity", "homeassistant.restart", config)).toBe(3);
    });

    it("matches wildcard action suffix", () => {
      expect(
        resolveTier("unknown.entity", "homeassistant.reload_automations", config),
      ).toBe(3);
    });

    it("matches action for tier 0", () => {
      expect(
        resolveTier("unknown.entity", "homeassistant.get_state", config),
      ).toBe(0);
    });
  });

  describe("default tier (priority 5)", () => {
    it("returns default tier for unclassified entity with no action", () => {
      expect(resolveTier("unknown.entity", undefined, config)).toBe(3);
    });

    it("returns default tier for unclassified entity and unclassified action", () => {
      expect(resolveTier("unknown.entity", "unknown.action", config)).toBe(3);
    });

    it("respects a different default tier", () => {
      const permissiveConfig = createTestConfig({ default_tier: 0 });
      expect(resolveTier("unknown.entity", undefined, permissiveConfig)).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles entity with no domain separator", () => {
      // Should not match any domain pattern, falls to default
      expect(resolveTier("nodomain", undefined, config)).toBe(3);
    });

    it("handles empty entity_overrides", () => {
      const noOverrides = createTestConfig({ entity_overrides: {} });
      // Should fall through to domain matching
      expect(resolveTier("light.nursery", undefined, noOverrides)).toBe(1);
    });

    it("handles config with no entity_overrides key", () => {
      const noOverrides = createTestConfig();
      // Remove entity_overrides entirely
      delete noOverrides.policy.entity_overrides;
      expect(resolveTier("light.nursery", undefined, noOverrides)).toBe(1);
    });
  });
});
