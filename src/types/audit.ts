/**
 * Types for the structured audit log.
 */

import type { PolicyDecisionKind, PolicyTier } from "./policy.js";

/** A single entry in the audit log. */
export interface AuditLogEntry {
  /** Auto-incremented primary key. */
  id?: number;
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
  /** UUID correlating with the MCP request. */
  request_id: string;
  /** Name of the MCP tool that was called. */
  tool_name: string;
  /** Target entity, if applicable. */
  entity_id?: string;
  /** The HA service action, if applicable. */
  action?: string;
  /** JSON-serialised tool call parameters. */
  parameters?: string;
  /** The tier resolved for this call. */
  policy_tier: PolicyTier;
  /** The outcome of the policy evaluation. */
  policy_decision: PolicyDecisionKind;
  /** JSON: original values before clamping, if applicable. */
  clamped_from?: string;
  /** JSON: adjusted values after clamping, if applicable. */
  clamped_to?: string;
  /** JSON: entity state before execution. */
  state_before?: string;
  /** JSON: entity state after execution. */
  state_after?: string;
  /** Time taken to execute the HA API call, in milliseconds. */
  execution_duration_ms?: number;
  /** Error message, if execution failed. */
  error?: string;
  /** Natural language rationale from the LLM, if provided. */
  llm_rationale?: string;
}
