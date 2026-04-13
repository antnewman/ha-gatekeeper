import { describe, it, expect, vi } from "vitest";
import {
  captureStateBefore,
  captureStateAfter,
  compareStates,
} from "../../../src/execution/state-capture.js";
import type { HAClient } from "../../../src/execution/ha-client.js";

function createMockHAClient(
  entities: Record<string, { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string; context: { id: string; parent_id: string | null; user_id: string | null } }>,
): HAClient {
  return {
    getEntityState: vi.fn((entityId: string) => entities[entityId]),
    entityExists: vi.fn((entityId: string) => entityId in entities),
  } as unknown as HAClient;
}

describe("state-capture", () => {
  const mockEntity = {
    entity_id: "light.test",
    state: "off",
    attributes: { brightness: 0 },
    last_changed: "2026-04-13T10:00:00Z",
    last_updated: "2026-04-13T10:00:00Z",
    context: { id: "ctx1", parent_id: null, user_id: null },
  };

  describe("captureStateBefore", () => {
    it("captures the current entity state", () => {
      const client = createMockHAClient({ "light.test": mockEntity });
      const state = captureStateBefore(client, "light.test");

      expect(state).not.toBeNull();
      expect(state!.entity_id).toBe("light.test");
      expect(state!.state).toBe("off");
    });

    it("returns null for non-existent entity", () => {
      const client = createMockHAClient({});
      const state = captureStateBefore(client, "light.nonexistent");
      expect(state).toBeNull();
    });
  });

  describe("captureStateAfter", () => {
    it("waits for the settling delay before capturing", async () => {
      vi.useFakeTimers();
      const client = createMockHAClient({ "light.test": mockEntity });

      const promise = captureStateAfter(client, "light.test", 500);
      await vi.advanceTimersByTimeAsync(500);
      const state = await promise;

      expect(state).not.toBeNull();
      expect(state!.entity_id).toBe("light.test");
      vi.useRealTimers();
    });
  });

  describe("compareStates", () => {
    it("detects a state change", () => {
      const before = { ...mockEntity, state: "off", attributes: { brightness: 0 } };
      const after = { ...mockEntity, state: "on", attributes: { brightness: 255 } };

      const result = compareStates("light.test", before, after);
      expect(result.stateChanged).toBe(true);
    });

    it("reports no change when states are identical", () => {
      const result = compareStates("light.test", mockEntity, { ...mockEntity });
      expect(result.stateChanged).toBe(false);
    });

    it("reports no change when both are null", () => {
      const result = compareStates("light.test", null, null);
      expect(result.stateChanged).toBe(false);
    });

    it("reports no change when before is null", () => {
      const result = compareStates("light.test", null, mockEntity);
      expect(result.stateChanged).toBe(false);
    });

    it("detects attribute-only change", () => {
      const before = { ...mockEntity, attributes: { brightness: 100 } };
      const after = { ...mockEntity, attributes: { brightness: 200 } };

      const result = compareStates("light.test", before, after);
      expect(result.stateChanged).toBe(true);
    });
  });
});
