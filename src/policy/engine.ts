/**
 * Core policy evaluation logic.
 *
 * Orchestrates tier resolution, rate limiting, and range clamping to produce
 * a deterministic policy decision for every tool call.
 */

import type { GatekeeperConfig } from "../config/schema.js";
import type { PolicyDecision } from "../types/policy.js";
import { resolveTier } from "./tier-resolver.js";
import { RateLimiter } from "./rate-limiter.js";
import { clampValue, type ClampResult } from "./range-clamper.js";

/** Parameters for a policy evaluation. */
export interface PolicyEvaluationParams {
  /** The target entity ID. */
  entityId: string;
  /** The service action being called (e.g. "light.turn_on"). */
  action?: string;
  /** Numeric values to clamp, keyed by attribute (e.g. { "climate.temperature": 30 }). */
  numericValues?: Record<string, number>;
}

/**
 * Deterministic policy engine.
 *
 * Evaluates tool calls against the configured policy tiers, rate limits,
 * and range clamps. Does not handle HITL confirmation -- that is the
 * responsibility of the caller.
 */
export class PolicyEngine {
  private readonly config: GatekeeperConfig;
  private readonly rateLimiter: RateLimiter;

  constructor(config: GatekeeperConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter();
  }

  /**
   * Evaluate whether a tool call is permitted by policy.
   *
   * @param params - The entity, action, and optional numeric values to evaluate.
   * @returns A deterministic policy decision.
   */
  evaluate(params: PolicyEvaluationParams): PolicyDecision {
    const { entityId, action, numericValues } = params;
    const tier = resolveTier(entityId, action, this.config);

    // Tier 0: unrestricted, execute immediately
    if (tier === 0) {
      return {
        tier,
        permitted: true,
        decision: "allowed",
        reason: `Entity '${entityId}' is Tier 0 (Unrestricted).`,
      };
    }

    // Tier 3: prohibited, never execute
    if (tier === 3) {
      return {
        tier,
        permitted: false,
        decision: "denied_prohibited",
        reason: `This action is not permitted by policy. Entity '${entityId}' is classified as Tier 3 (Prohibited).`,
      };
    }

    // Tiers 1 and 2: check rate limit
    const tierConfig = this.config.policy.tiers[String(tier)];
    const rateLimit = tierConfig?.constraints?.rate_limit;

    if (rateLimit) {
      const rateLimitResult = this.rateLimiter.checkRateLimit(
        entityId,
        rateLimit.max_calls_per_entity_per_minute,
      );

      if (!rateLimitResult.allowed) {
        return {
          tier,
          permitted: false,
          decision: "denied_rate_limit",
          reason: `Rate limit exceeded for '${entityId}'. Retry after ${String(rateLimitResult.retryAfterMs)}ms.`,
        };
      }
    }

    // Tier 2: apply range clamping if numeric values are provided
    if (tier === 2 && numericValues) {
      const rangeClampConfig = tierConfig?.constraints?.range_clamp;
      const clampedFrom: Record<string, number> = {};
      const clampedTo: Record<string, number> = {};
      let anyClamped = false;

      for (const [attribute, value] of Object.entries(numericValues)) {
        const result: ClampResult = clampValue(
          attribute,
          value,
          rangeClampConfig,
        );

        if (result.clamped) {
          anyClamped = true;
          clampedFrom[attribute] = result.originalValue;
          clampedTo[attribute] = result.value;
        }
      }

      if (anyClamped) {
        return {
          tier,
          permitted: true,
          decision: "clamped",
          reason: `Values clamped for '${entityId}'. Tier 2 (Confirmed) -- confirmation required.`,
          clampedFrom,
          clampedTo,
        };
      }
    }

    // Tier 1: allowed, Tier 2: allowed (confirmation handled by caller)
    const tierName = tier === 1 ? "Logged" : "Confirmed";
    return {
      tier,
      permitted: true,
      decision: "allowed",
      reason: `Entity '${entityId}' is Tier ${String(tier)} (${tierName}).`,
    };
  }

  /** Reset the rate limiter state. Useful for testing. */
  resetRateLimits(): void {
    this.rateLimiter.resetAll();
  }
}
