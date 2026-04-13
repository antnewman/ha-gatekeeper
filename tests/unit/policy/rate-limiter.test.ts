import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RateLimiter } from "../../../src/policy/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows calls under the limit", () => {
    const result = limiter.checkRateLimit("light.test", 10);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("allows calls up to exactly the limit", () => {
    for (let i = 0; i < 10; i++) {
      const result = limiter.checkRateLimit("light.test", 10);
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects calls over the limit", () => {
    for (let i = 0; i < 10; i++) {
      limiter.checkRateLimit("light.test", 10);
    }

    const result = limiter.checkRateLimit("light.test", 10);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("provides a retryAfterMs value when rate limited", () => {
    for (let i = 0; i < 3; i++) {
      limiter.checkRateLimit("light.test", 3);
    }

    const result = limiter.checkRateLimit("light.test", 3);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    // Should be close to 60000ms (the full window)
    expect(result.retryAfterMs).toBeLessThanOrEqual(60000);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows calls again after the window expires", () => {
    for (let i = 0; i < 5; i++) {
      limiter.checkRateLimit("light.test", 5);
    }

    expect(limiter.checkRateLimit("light.test", 5).allowed).toBe(false);

    // Advance time past the 60s window
    vi.advanceTimersByTime(61_000);

    const result = limiter.checkRateLimit("light.test", 5);
    expect(result.allowed).toBe(true);
  });

  it("tracks entities independently", () => {
    for (let i = 0; i < 3; i++) {
      limiter.checkRateLimit("light.a", 3);
    }

    expect(limiter.checkRateLimit("light.a", 3).allowed).toBe(false);
    expect(limiter.checkRateLimit("light.b", 3).allowed).toBe(true);
  });

  it("allows a call when the oldest entry expires from the window", () => {
    // Make 3 calls at t=0
    for (let i = 0; i < 3; i++) {
      limiter.checkRateLimit("light.test", 3);
    }

    expect(limiter.checkRateLimit("light.test", 3).allowed).toBe(false);

    // Advance 61s -- all 3 calls from t=0 have expired
    vi.advanceTimersByTime(61_000);

    expect(limiter.checkRateLimit("light.test", 3).allowed).toBe(true);
  });

  it("reset clears a specific entity", () => {
    for (let i = 0; i < 3; i++) {
      limiter.checkRateLimit("light.test", 3);
    }

    expect(limiter.checkRateLimit("light.test", 3).allowed).toBe(false);

    limiter.reset("light.test");

    expect(limiter.checkRateLimit("light.test", 3).allowed).toBe(true);
  });

  it("resetAll clears all entities", () => {
    for (let i = 0; i < 3; i++) {
      limiter.checkRateLimit("light.a", 3);
      limiter.checkRateLimit("light.b", 3);
    }

    limiter.resetAll();

    expect(limiter.checkRateLimit("light.a", 3).allowed).toBe(true);
    expect(limiter.checkRateLimit("light.b", 3).allowed).toBe(true);
  });

  it("handles a limit of 1", () => {
    expect(limiter.checkRateLimit("light.test", 1).allowed).toBe(true);
    expect(limiter.checkRateLimit("light.test", 1).allowed).toBe(false);
  });
});
