import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../../../src/execution/circuit-breaker.js";

vi.mock("../../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryThreshold: 2,
      timeoutMs: 5000,
      healthCheckIntervalMs: 10000,
    });
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  it("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
    expect(breaker.isAllowing()).toBe(true);
  });

  it("remains closed on successful calls", async () => {
    await breaker.execute(async () => "ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("transitions to open after failure threshold", () => {
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe("open");
    expect(breaker.isAllowing()).toBe(false);
  });

  it("rejects calls when open", async () => {
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure();
    }

    await expect(breaker.execute(async () => "ok")).rejects.toThrow(
      CircuitBreakerOpenError,
    );
  });

  it("resets failure count on success", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    // Should still be closed: success reset the count
    expect(breaker.getState()).toBe("closed");
  });

  it("transitions to half-open after health check passes", async () => {
    breaker.setHealthCheck(async () => true);

    for (let i = 0; i < 3; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe("open");

    // Advance past health check interval
    await vi.advanceTimersByTimeAsync(10001);

    expect(breaker.getState()).toBe("half_open");
  });

  it("transitions from half-open to closed after recovery threshold", async () => {
    breaker.setHealthCheck(async () => true);

    // Trip to open
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure();
    }

    // Health check -> half-open
    await vi.advanceTimersByTimeAsync(10001);
    expect(breaker.getState()).toBe("half_open");

    // Recovery successes
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("half_open");
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("transitions from half-open back to open on any failure", async () => {
    breaker.setHealthCheck(async () => true);

    for (let i = 0; i < 3; i++) {
      breaker.recordFailure();
    }

    await vi.advanceTimersByTimeAsync(10001);
    expect(breaker.getState()).toBe("half_open");

    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
  });

  it("times out slow operations", async () => {
    // Use a promise that never resolves (no internal timers to conflict with fake timers)
    const neverResolves = () => new Promise<string>(() => {
      // intentionally never resolves
    });

    const promise = breaker.execute(neverResolves);

    // Catch the rejection before advancing timers to prevent unhandled rejection
    const caught = promise.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(5001);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("timeout exceeded");
  });

  it("stays open when health check fails", async () => {
    breaker.setHealthCheck(async () => false);

    for (let i = 0; i < 3; i++) {
      breaker.recordFailure();
    }

    await vi.advanceTimersByTimeAsync(10001);
    expect(breaker.getState()).toBe("open");
  });
});
