import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuditLog } from "../../../src/observability/audit-log.js";
import type { AuditLogEntry } from "../../../src/types/audit.js";

vi.mock("../../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createEntry(overrides?: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    request_id: "req-001",
    tool_name: "turn_on",
    entity_id: "light.living_room",
    action: "light.turn_on",
    parameters: JSON.stringify({ brightness: 255 }),
    policy_tier: 1,
    policy_decision: "allowed",
    ...overrides,
  };
}

describe("AuditLog", () => {
  let auditLog: AuditLog;

  beforeEach(() => {
    auditLog = new AuditLog(":memory:");
  });

  afterEach(() => {
    auditLog.close();
  });

  describe("write and query", () => {
    it("writes and reads back an entry", () => {
      const entry = createEntry();
      auditLog.write(entry);

      const results = auditLog.query();
      expect(results).toHaveLength(1);

      const result = results[0]!;
      expect(result.tool_name).toBe("turn_on");
      expect(result.entity_id).toBe("light.living_room");
      expect(result.policy_tier).toBe(1);
      expect(result.policy_decision).toBe("allowed");
    });

    it("writes multiple entries and returns them in reverse order", () => {
      auditLog.write(createEntry({ request_id: "req-001" }));
      auditLog.write(createEntry({ request_id: "req-002" }));
      auditLog.write(createEntry({ request_id: "req-003" }));

      const results = auditLog.query();
      expect(results).toHaveLength(3);
      expect(results[0]!.request_id).toBe("req-003");
      expect(results[2]!.request_id).toBe("req-001");
    });

    it("writes entries with optional fields as null", () => {
      auditLog.write({
        timestamp: new Date().toISOString(),
        request_id: "req-minimal",
        tool_name: "get_entity_state",
        policy_tier: 0,
        policy_decision: "allowed",
      });

      const results = auditLog.query();
      expect(results).toHaveLength(1);
      expect(results[0]!.entity_id).toBeNull();
      expect(results[0]!.error).toBeNull();
    });

    it("records clamped values", () => {
      auditLog.write(
        createEntry({
          policy_decision: "clamped",
          clamped_from: JSON.stringify({ "climate.temperature": 30 }),
          clamped_to: JSON.stringify({ "climate.temperature": 25 }),
        }),
      );

      const results = auditLog.query();
      expect(results[0]!.policy_decision).toBe("clamped");
      expect(results[0]!.clamped_from).toBe(
        JSON.stringify({ "climate.temperature": 30 }),
      );
    });

    it("records state before and after", () => {
      const stateBefore = JSON.stringify({ state: "off" });
      const stateAfter = JSON.stringify({ state: "on" });

      auditLog.write(
        createEntry({
          state_before: stateBefore,
          state_after: stateAfter,
          execution_duration_ms: 150,
        }),
      );

      const results = auditLog.query();
      expect(results[0]!.state_before).toBe(stateBefore);
      expect(results[0]!.state_after).toBe(stateAfter);
      expect(results[0]!.execution_duration_ms).toBe(150);
    });
  });

  describe("query filters", () => {
    beforeEach(() => {
      auditLog.write(
        createEntry({
          entity_id: "light.a",
          tool_name: "turn_on",
          policy_decision: "allowed",
        }),
      );
      auditLog.write(
        createEntry({
          entity_id: "light.b",
          tool_name: "turn_off",
          policy_decision: "allowed",
        }),
      );
      auditLog.write(
        createEntry({
          entity_id: "automation.test",
          tool_name: "turn_on",
          policy_decision: "denied_prohibited",
        }),
      );
    });

    it("filters by entity_id", () => {
      const results = auditLog.query({ entityId: "light.a" });
      expect(results).toHaveLength(1);
      expect(results[0]!.entity_id).toBe("light.a");
    });

    it("filters by tool_name", () => {
      const results = auditLog.query({ toolName: "turn_on" });
      expect(results).toHaveLength(2);
    });

    it("filters by policy_decision", () => {
      const results = auditLog.query({ policyDecision: "denied_prohibited" });
      expect(results).toHaveLength(1);
      expect(results[0]!.entity_id).toBe("automation.test");
    });

    it("limits results", () => {
      const results = auditLog.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("combines multiple filters", () => {
      const results = auditLog.query({
        toolName: "turn_on",
        policyDecision: "allowed",
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.entity_id).toBe("light.a");
    });
  });

  describe("cleanup", () => {
    it("deletes entries older than retention period", () => {
      // Write an entry with a timestamp 100 days ago
      const oldDate = new Date(
        Date.now() - 100 * 24 * 60 * 60 * 1000,
      ).toISOString();
      auditLog.write(createEntry({ timestamp: oldDate, request_id: "old" }));

      // Write a recent entry
      auditLog.write(
        createEntry({
          timestamp: new Date().toISOString(),
          request_id: "recent",
        }),
      );

      const deleted = auditLog.cleanup(90);
      expect(deleted).toBe(1);

      const remaining = auditLog.query();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.request_id).toBe("recent");
    });

    it("returns 0 when nothing to delete", () => {
      auditLog.write(createEntry());
      const deleted = auditLog.cleanup(90);
      expect(deleted).toBe(0);
    });
  });
});
