/**
 * Numeric value clamping for range-restricted attributes.
 *
 * Enforces hard min/max boundaries defined in the policy configuration.
 * If a requested value falls outside the configured range, it is silently
 * adjusted to the nearest boundary.
 */

import type { RangeClampBoundary } from "../types/policy.js";

/** Result of a clamping operation. */
export interface ClampResult {
  /** The value after clamping (may be unchanged). */
  value: number;
  /** Whether the value was clamped. */
  clamped: boolean;
  /** The original requested value. */
  originalValue: number;
}

/**
 * Clamp a numeric value to the configured range for a given attribute.
 *
 * The lookup key is `domain.attribute` (e.g. `climate.temperature`).
 * If no range is configured for the attribute, the value passes through unchanged.
 *
 * @param attribute - The attribute key to look up in the range clamp config (e.g. "climate.temperature").
 * @param value - The requested numeric value.
 * @param rangeClampConfig - Map of attribute keys to min/max boundaries.
 * @returns The clamping result with the final value and whether clamping occurred.
 */
export function clampValue(
  attribute: string,
  value: number,
  rangeClampConfig: Record<string, RangeClampBoundary> | undefined,
): ClampResult {
  if (!rangeClampConfig) {
    return { value, clamped: false, originalValue: value };
  }

  const boundary = rangeClampConfig[attribute];
  if (!boundary) {
    return { value, clamped: false, originalValue: value };
  }

  if (value < boundary.min) {
    return { value: boundary.min, clamped: true, originalValue: value };
  }

  if (value > boundary.max) {
    return { value: boundary.max, clamped: true, originalValue: value };
  }

  return { value, clamped: false, originalValue: value };
}
