import { describe, it, expect, vi } from "vitest";
import {
  validateEntity,
  levenshteinDistance,
} from "../../../src/server/entity-validator.js";
import type { HAClient } from "../../../src/execution/ha-client.js";

function createMockHAClient(
  entityIds: string[],
): HAClient {
  const entities: Record<string, { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string; context: { id: string; parent_id: string | null; user_id: string | null } }> = {};

  for (const id of entityIds) {
    entities[id] = {
      entity_id: id,
      state: "on",
      attributes: {},
      last_changed: "2026-04-13T10:00:00Z",
      last_updated: "2026-04-13T10:00:00Z",
      context: { id: "ctx", parent_id: null, user_id: null },
    };
  }

  return {
    getEntityState: vi.fn((id: string) => entities[id]),
    entityExists: vi.fn((id: string) => id in entities),
    getAllEntities: vi.fn(() => ({ ...entities })),
    callService: vi.fn(),
    isConnected: true,
    entityCount: entityIds.length,
    connectionState: "connected" as const,
  } as unknown as HAClient;
}

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("kitchen", "kitchen")).toBe(0);
  });

  it("returns the correct distance for a single character difference", () => {
    // "kichen" vs "kitchen" -- missing 't'
    expect(levenshteinDistance("kichen", "kitchen")).toBe(1);
  });

  it("returns the correct distance for distant strings", () => {
    expect(levenshteinDistance("kitchen", "bedroom")).toBeGreaterThan(5);
  });

  it("handles empty strings", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns correct distance for transposition", () => {
    // "litving" vs "living" -- extra 't'
    expect(levenshteinDistance("litving", "living")).toBe(1);
  });
});

describe("validateEntity", () => {
  const client = createMockHAClient([
    "light.kitchen",
    "light.kitchen_island",
    "light.kitchen_cabinet",
    "light.living_room",
    "light.bedroom",
    "light.nursery",
    "sensor.temperature_kitchen",
    "sensor.humidity_kitchen",
    "climate.bedroom",
  ]);

  it("returns valid for an existing entity", () => {
    const result = validateEntity("light.kitchen", client);
    expect(result.valid).toBe(true);
    expect(result.entityId).toBe("light.kitchen");
    expect(result.suggestions).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("returns suggestions for a close typo", () => {
    const result = validateEntity("light.kichen", client);
    expect(result.valid).toBe(false);
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions).toContain("light.kitchen");
    expect(result.error).toContain("Similar entities");
    expect(result.error).toContain("light.kitchen");
  });

  it("filters suggestions to the same domain only", () => {
    // "light.kichen" should only suggest light.* entities, never sensor.*
    const result = validateEntity("light.kichen", client);
    expect(result.valid).toBe(false);

    if (result.suggestions) {
      for (const suggestion of result.suggestions) {
        expect(suggestion.startsWith("light.")).toBe(true);
      }
    }
  });

  it("returns no suggestions for a completely unrelated entity", () => {
    const result = validateEntity("light.zzzzzzzzzzzzz", client);
    expect(result.valid).toBe(false);
    // Distance would be too high for any match
    expect(result.suggestions).toBeUndefined();
  });

  it("caps suggestions at 3 even if more matches exist", () => {
    // "light.kitche" is close to kitchen, kitchen_island, kitchen_cabinet
    const result = validateEntity("light.kitche", client);
    expect(result.valid).toBe(false);
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions!.length).toBeLessThanOrEqual(3);
  });

  it("rejects entity IDs with invalid format", () => {
    const result = validateEntity("nodomain", client);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid entity ID format");
    expect(result.suggestions).toBeUndefined();
  });

  it("rejects entity IDs with empty object_id", () => {
    const result = validateEntity("light.", client);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid entity ID format");
  });

  it("returns non-existent domain with no suggestions", () => {
    const result = validateEntity("fan.bedroom", client);
    expect(result.valid).toBe(false);
    // No fan.* entities exist, so no suggestions possible
    expect(result.suggestions).toBeUndefined();
    expect(result.error).toContain("does not exist");
  });

  it("sorts suggestions by distance then alphabetically", () => {
    // "light.kitche" -- kitchen (dist 1), kitchen_island (dist 8), kitchen_cabinet (dist 9)
    // Only kitchen should be within distance 5
    const result = validateEntity("light.kitche", client);
    expect(result.valid).toBe(false);
    expect(result.suggestions).toBeDefined();
    // kitchen (dist 1) should be first
    expect(result.suggestions![0]).toBe("light.kitchen");
  });
});
