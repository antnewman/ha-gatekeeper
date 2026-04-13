/**
 * Three-state circuit breaker: CLOSED, OPEN, HALF_OPEN.
 *
 * Protects against cascading failures when the Home Assistant
 * connection degrades. Control calls are rejected when the circuit
 * is open; read calls may still attempt to pass through.
 */

import { logger } from "../logger.js";

/** Circuit breaker states. */
export type CircuitBreakerState = "closed" | "open" | "half_open";

/** Configuration for the circuit breaker. */
export interface CircuitBreakerConfig {
  /** Consecutive failures required to trip the breaker. */
  failureThreshold: number;
  /** Consecutive successes required to reset from half-open to closed. */
  recoveryThreshold: number;
  /** Maximum time in milliseconds for any operation. */
  timeoutMs: number;
  /** Milliseconds between health checks when the circuit is open. */
  healthCheckIntervalMs: number;
}

/** Error thrown when the circuit breaker is open. */
export class CircuitBreakerOpenError extends Error {
  constructor() {
    super(
      "Circuit breaker is open. Home Assistant connection is degraded. Control actions are temporarily unavailable.",
    );
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * Three-state circuit breaker for protecting HA API calls.
 *
 * - CLOSED: normal operation, all requests pass through.
 * - OPEN: all control requests rejected, health checks attempted periodically.
 * - HALF_OPEN: limited requests allowed, testing recovery.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private readonly config: CircuitBreakerConfig;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private onHealthCheck: (() => Promise<boolean>) | null = null;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  /** Get the current circuit breaker state. */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /** Whether the circuit breaker is allowing requests through. */
  isAllowing(): boolean {
    return this.state !== "open";
  }

  /**
   * Register a health check function called periodically when the circuit is open.
   *
   * @param fn - Async function that returns true if the connection is healthy.
   */
  setHealthCheck(fn: () => Promise<boolean>): void {
    this.onHealthCheck = fn;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @param fn - The async function to execute.
   * @returns The function's return value.
   * @throws CircuitBreakerOpenError if the circuit is open.
   * @throws The original error if the function fails.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Circuit breaker timeout exceeded"));
        }, this.config.timeoutMs);

        fn().then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });

      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /** Record a successful operation. */
  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === "half_open") {
      this.successCount++;
      logger.debug(
        {
          successCount: this.successCount,
          threshold: this.config.recoveryThreshold,
        },
        "Circuit breaker half-open: success recorded",
      );

      if (this.successCount >= this.config.recoveryThreshold) {
        this.transitionTo("closed");
      }
    }
  }

  /** Record a failed operation. */
  recordFailure(): void {
    this.successCount = 0;
    this.failureCount++;

    logger.warn(
      {
        failureCount: this.failureCount,
        threshold: this.config.failureThreshold,
        state: this.state,
      },
      "Circuit breaker: failure recorded",
    );

    if (this.state === "half_open") {
      // Any failure in half-open goes back to open
      this.transitionTo("open");
    } else if (
      this.state === "closed" &&
      this.failureCount >= this.config.failureThreshold
    ) {
      this.transitionTo("open");
    }
  }

  /** Force a transition to a specific state. Used for health check recovery. */
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;
    this.failureCount = 0;
    this.successCount = 0;

    logger.info(
      { from: oldState, to: newState },
      "Circuit breaker state transition",
    );

    if (newState === "open") {
      this.startHealthChecks();
    } else {
      this.stopHealthChecks();
    }
  }

  /** Start periodic health checks when the circuit is open. */
  private startHealthChecks(): void {
    this.stopHealthChecks();

    if (!this.onHealthCheck) {
      return;
    }

    const healthCheck = this.onHealthCheck;

    this.healthCheckTimer = setInterval(() => {
      void (async () => {
        try {
          const healthy = await healthCheck();
          if (healthy) {
            logger.info("Circuit breaker health check passed, transitioning to half-open");
            this.transitionTo("half_open");
          }
        } catch {
          logger.debug("Circuit breaker health check failed");
        }
      })();
    }, this.config.healthCheckIntervalMs);
  }

  /** Stop periodic health checks. */
  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Clean up resources (timers). Call on shutdown. */
  destroy(): void {
    this.stopHealthChecks();
  }
}
