import { describe, it, expect } from "vitest";
import { clampValue } from "../../../src/policy/range-clamper.js";
import type { RangeClampBoundary } from "../../../src/types/policy.js";

describe("clampValue", () => {
  const rangeClampConfig: Record<string, RangeClampBoundary> = {
    "climate.temperature": { min: 15, max: 25 },
    "climate.target_temp_high": { min: 15, max: 28 },
    "climate.target_temp_low": { min: 12, max: 22 },
  };

  it("passes through a value within range", () => {
    const result = clampValue("climate.temperature", 20, rangeClampConfig);
    expect(result.value).toBe(20);
    expect(result.clamped).toBe(false);
    expect(result.originalValue).toBe(20);
  });

  it("clamps a value below the minimum", () => {
    const result = clampValue("climate.temperature", 10, rangeClampConfig);
    expect(result.value).toBe(15);
    expect(result.clamped).toBe(true);
    expect(result.originalValue).toBe(10);
  });

  it("clamps a value above the maximum", () => {
    const result = clampValue("climate.temperature", 30, rangeClampConfig);
    expect(result.value).toBe(25);
    expect(result.clamped).toBe(true);
    expect(result.originalValue).toBe(30);
  });

  it("allows a value exactly at the minimum boundary", () => {
    const result = clampValue("climate.temperature", 15, rangeClampConfig);
    expect(result.value).toBe(15);
    expect(result.clamped).toBe(false);
  });

  it("allows a value exactly at the maximum boundary", () => {
    const result = clampValue("climate.temperature", 25, rangeClampConfig);
    expect(result.value).toBe(25);
    expect(result.clamped).toBe(false);
  });

  it("passes through when no config exists for the attribute", () => {
    const result = clampValue("light.brightness", 300, rangeClampConfig);
    expect(result.value).toBe(300);
    expect(result.clamped).toBe(false);
  });

  it("passes through when rangeClampConfig is undefined", () => {
    const result = clampValue("climate.temperature", 50, undefined);
    expect(result.value).toBe(50);
    expect(result.clamped).toBe(false);
  });

  it("works with different attribute configs", () => {
    const result = clampValue("climate.target_temp_low", 5, rangeClampConfig);
    expect(result.value).toBe(12);
    expect(result.clamped).toBe(true);
    expect(result.originalValue).toBe(5);
  });

  it("handles negative values", () => {
    const config: Record<string, RangeClampBoundary> = {
      "sensor.value": { min: -10, max: 10 },
    };
    const result = clampValue("sensor.value", -20, config);
    expect(result.value).toBe(-10);
    expect(result.clamped).toBe(true);
  });

  it("handles decimal values", () => {
    const result = clampValue("climate.temperature", 15.5, rangeClampConfig);
    expect(result.value).toBe(15.5);
    expect(result.clamped).toBe(false);
  });
});
