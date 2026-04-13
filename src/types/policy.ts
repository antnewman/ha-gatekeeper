/**
 * Types for the policy engine: tier classification, decisions, and configuration.
 */

/** Policy tier levels. Higher numbers are more restrictive. */
export type PolicyTier = 0 | 1 | 2 | 3;

/** The outcome of a policy evaluation. */
export type PolicyDecisionKind =
  | "allowed"
  | "denied_rate_limit"
  | "denied_prohibited"
  | "denied_timeout"
  | "confirmed"
  | "clamped";

/** Full result of evaluating a tool call against the policy engine. */
export interface PolicyDecision {
  /** The tier that was resolved for this entity/action. */
  tier: PolicyTier;
  /** Whether the action is permitted to proceed. */
  permitted: boolean;
  /** The specific decision outcome. */
  decision: PolicyDecisionKind;
  /** Human-readable reason for the decision. */
  reason: string;
  /** If value clamping occurred, the original requested value. */
  clampedFrom?: Record<string, number>;
  /** If value clamping occurred, the adjusted value. */
  clampedTo?: Record<string, number>;
}

/** Rate limit configuration for a tier. */
export interface RateLimitConfig {
  max_calls_per_entity_per_minute: number;
}

/** Range clamp boundary for a numeric attribute. */
export interface RangeClampBoundary {
  min: number;
  max: number;
}

/** Confirmation configuration for Tier 2 actions. */
export interface ConfirmationConfig {
  method: "notification" | "webhook";
  timeout_seconds: number;
  notification_service: string;
  message_template: string;
}

/** Constraints that can be applied to a tier. */
export interface TierConstraints {
  rate_limit?: RateLimitConfig;
  confirmation?: ConfirmationConfig;
  range_clamp?: Record<string, RangeClampBoundary>;
}

/** Configuration for a single policy tier. */
export interface TierConfig {
  description: string;
  domains?: string[];
  entities?: string[];
  actions?: string[];
  constraints?: TierConstraints;
}

/** Top-level policy configuration from config.yaml. */
export interface PolicyConfig {
  default_tier: PolicyTier;
  tiers: Partial<Record<PolicyTier, TierConfig>>;
  entity_overrides?: Record<string, PolicyTier>;
}
