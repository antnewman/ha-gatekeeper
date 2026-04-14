/**
 * Entity validator with fuzzy matching for hallucinated entity names.
 *
 * Implements Layer 03 (Making Failures Visible) from "Verified Autonomy:
 * A Field Guide to Engineering Trust in AI Systems" (Newman & Greene, 2026).
 *
 * When a tool call targets a non-existent entity, the validator returns
 * up to 3 fuzzy-matched suggestions from the same domain, making the
 * failure visible so the LLM can self-correct.
 */

import type { HAClient } from "../execution/ha-client.js";

/** Maximum Levenshtein distance to consider a match a plausible typo. */
const MAX_SUGGESTION_DISTANCE = 5;

/** Maximum number of suggestions to return. */
const MAX_SUGGESTIONS = 3;

/** Result of validating an entity ID against the live HA state. */
export interface EntityValidationResult {
  /** Whether the entity exists. */
  valid: boolean;
  /** The entity ID that was validated. */
  entityId: string;
  /** Up to 3 closest matches from the same domain, if the entity is invalid. */
  suggestions?: string[];
  /** Human-readable error message with suggestions, if the entity is invalid. */
  error?: string;
}

/**
 * Compute the Levenshtein distance (edit distance) between two strings.
 *
 * Uses the standard dynamic programming algorithm. No external dependencies.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns The minimum number of single-character edits (insertions, deletions,
 *          or substitutions) required to transform a into b.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimisation: if either string is empty, the distance is the other's length
  if (m === 0) return n;
  if (n === 0) return m;

  // Use two rows instead of full matrix for space efficiency
  let previousRow = new Array<number>(n + 1);
  let currentRow = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    previousRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    currentRow[0] = i;

    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previousRow[j] ?? 0) + 1;
      const insertion = (currentRow[j - 1] ?? 0) + 1;
      const substitution = (previousRow[j - 1] ?? 0) + cost;
      currentRow[j] = Math.min(deletion, insertion, substitution);
    }

    [previousRow, currentRow] = [currentRow, previousRow];
  }

  return previousRow[n] ?? 0;
}

/**
 * Validate an entity ID against the live HA entity state cache.
 *
 * If the entity does not exist, returns fuzzy-matched suggestions from
 * entities in the same domain to help the LLM self-correct.
 *
 * @param entityId - The entity ID to validate (e.g. "light.kichen").
 * @param haClient - The HA client with a live entity cache.
 * @returns Validation result with suggestions if the entity is invalid.
 */
export function validateEntity(
  entityId: string,
  haClient: HAClient,
): EntityValidationResult {
  // Check for valid format
  const dotIdx = entityId.indexOf(".");
  if (dotIdx <= 0 || dotIdx === entityId.length - 1) {
    return {
      valid: false,
      entityId,
      error: `Invalid entity ID format: '${entityId}'. Expected format: 'domain.object_id'.`,
    };
  }

  // Check if entity exists
  if (haClient.entityExists(entityId)) {
    return { valid: true, entityId };
  }

  // Entity does not exist -- find fuzzy matches in the same domain
  const requestedDomain = entityId.slice(0, dotIdx);
  const requestedObjectId = entityId.slice(dotIdx + 1);

  const allEntities = haClient.getAllEntities();
  const candidates: Array<{ entityId: string; distance: number }> = [];

  for (const entity of Object.values(allEntities)) {
    const candidateDotIdx = entity.entity_id.indexOf(".");
    if (candidateDotIdx <= 0) continue;

    const candidateDomain = entity.entity_id.slice(0, candidateDotIdx);
    if (candidateDomain !== requestedDomain) continue;

    const candidateObjectId = entity.entity_id.slice(candidateDotIdx + 1);
    const distance = levenshteinDistance(requestedObjectId, candidateObjectId);

    if (distance <= MAX_SUGGESTION_DISTANCE) {
      candidates.push({ entityId: entity.entity_id, distance });
    }
  }

  // Sort by distance (closest first), then alphabetically for ties
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.entityId.localeCompare(b.entityId);
  });

  const suggestions = candidates
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => c.entityId);

  let error = `Entity '${entityId}' does not exist in Home Assistant.`;
  if (suggestions.length > 0) {
    error += ` Similar entities: ${suggestions.join(", ")}`;
  }

  const result: EntityValidationResult = {
    valid: false,
    entityId,
    error,
  };

  if (suggestions.length > 0) {
    result.suggestions = suggestions;
  }

  return result;
}
