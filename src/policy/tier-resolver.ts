/**
 * Tier classification: resolves an entity ID and/or action to a policy tier number.
 *
 * Resolution order (first match wins):
 * 1. entity_overrides for the specific entity_id
 * 2. tiers[n].entities lists for the specific entity_id
 * 3. tiers[n].domains for a matching domain pattern
 * 4. tiers[n].actions for the specific action
 * 5. default_tier (fallback)
 */

import type { PolicyTier } from "../types/policy.js";
import type { GatekeeperConfig } from "../config/schema.js";

/** Ordered tier keys for iteration (0, 1, 2, 3). */
const TIER_KEYS: PolicyTier[] = [0, 1, 2, 3];

/**
 * Check whether a value matches a wildcard pattern.
 * Supports two forms:
 * - `domain.*` matches any entity in that domain (e.g. `light.*` matches `light.living_room`)
 * - `prefix_*` matches any string starting with `prefix_` (e.g. `homeassistant.reload_*`)
 *
 * @param pattern - The pattern from configuration.
 * @param value - The value to test (entity_id or action).
 */
function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }

  // Domain wildcard: "light.*" matches "light.anything"
  if (pattern.endsWith(".*")) {
    const domainPrefix = pattern.slice(0, -1); // "light."
    return value.startsWith(domainPrefix);
  }

  // Suffix wildcard: "homeassistant.reload_*" matches "homeassistant.reload_automations"
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }

  return false;
}

/**
 * Resolve the policy tier for a given entity ID and optional action.
 *
 * @param entityId - The Home Assistant entity ID (e.g. "light.living_room").
 * @param action - The service action being called (e.g. "homeassistant.restart"). May be undefined for read operations.
 * @param config - The full validated configuration.
 * @returns The resolved policy tier (0-3).
 */
export function resolveTier(
  entityId: string,
  action: string | undefined,
  config: GatekeeperConfig,
): PolicyTier {
  const policy = config.policy;

  // 1. Check entity_overrides (highest priority)
  if (policy.entity_overrides) {
    const override = policy.entity_overrides[entityId];
    if (override !== undefined) {
      return override as PolicyTier;
    }
  }

  // 2. Check tiers[n].entities lists
  for (const tierKey of TIER_KEYS) {
    const tierConfig = policy.tiers[String(tierKey)];
    if (tierConfig?.entities) {
      for (const entity of tierConfig.entities) {
        if (entity === entityId) {
          return tierKey;
        }
      }
    }
  }

  // 3. Check tiers[n].domains for matching pattern
  for (const tierKey of TIER_KEYS) {
    const tierConfig = policy.tiers[String(tierKey)];
    if (tierConfig?.domains) {
      for (const domainPattern of tierConfig.domains) {
        if (matchesPattern(domainPattern, entityId)) {
          return tierKey;
        }
      }
    }
  }

  // 4. Check tiers[n].actions for matching action
  if (action !== undefined) {
    for (const tierKey of TIER_KEYS) {
      const tierConfig = policy.tiers[String(tierKey)];
      if (tierConfig?.actions) {
        for (const actionPattern of tierConfig.actions) {
          if (matchesPattern(actionPattern, action)) {
            return tierKey;
          }
        }
      }
    }
  }

  // 5. Fall back to default_tier
  return policy.default_tier as PolicyTier;
}
