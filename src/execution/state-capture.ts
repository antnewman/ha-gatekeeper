/**
 * Before/after state capture with settling delay.
 *
 * Records entity state before execution and again after a configurable
 * settling delay to account for devices (Zigbee, Z-Wave) that report
 * state changes asynchronously.
 */

import type { HAClient } from "./ha-client.js";
import type { EntityState } from "../types/ha.js";

/** Default settling delay in milliseconds. */
const DEFAULT_SETTLING_DELAY_MS = 500;

/** Result of a state capture comparison. */
export interface StateCaptureResult {
  entityId: string;
  stateBefore: EntityState | null;
  stateAfter: EntityState | null;
  stateChanged: boolean;
}

/**
 * Convert a HassEntity from the HA WebSocket library to our EntityState type.
 */
function toEntityState(
  hassEntity: { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string; context: { id: string; parent_id: string | null; user_id: string | null } } | undefined,
): EntityState | null {
  if (!hassEntity) {
    return null;
  }

  return {
    entity_id: hassEntity.entity_id,
    state: hassEntity.state,
    attributes: hassEntity.attributes,
    last_changed: hassEntity.last_changed,
    last_updated: hassEntity.last_updated,
    context: hassEntity.context,
  };
}

/**
 * Capture the current state of an entity from the HA state cache.
 *
 * @param haClient - The Home Assistant client with a live entity cache.
 * @param entityId - The entity to capture state for.
 * @returns The entity state, or null if the entity does not exist.
 */
export function captureStateBefore(
  haClient: HAClient,
  entityId: string,
): EntityState | null {
  return toEntityState(haClient.getEntityState(entityId));
}

/**
 * Wait for the settling delay, then capture the entity state.
 *
 * @param haClient - The Home Assistant client with a live entity cache.
 * @param entityId - The entity to capture state for.
 * @param settlingDelayMs - Milliseconds to wait before capturing. Defaults to 500ms.
 * @returns The entity state after the delay.
 */
export async function captureStateAfter(
  haClient: HAClient,
  entityId: string,
  settlingDelayMs: number = DEFAULT_SETTLING_DELAY_MS,
): Promise<EntityState | null> {
  await new Promise((resolve) => setTimeout(resolve, settlingDelayMs));
  return toEntityState(haClient.getEntityState(entityId));
}

/**
 * Compare two entity states and determine if a change occurred.
 *
 * @param entityId - The entity ID being compared.
 * @param before - State before execution.
 * @param after - State after execution.
 * @returns A comparison result with both states and a change flag.
 */
export function compareStates(
  entityId: string,
  before: EntityState | null,
  after: EntityState | null,
): StateCaptureResult {
  const stateChanged =
    before !== null &&
    after !== null &&
    (before.state !== after.state ||
      JSON.stringify(before.attributes) !== JSON.stringify(after.attributes));

  return {
    entityId,
    stateBefore: before,
    stateAfter: after,
    stateChanged,
  };
}
