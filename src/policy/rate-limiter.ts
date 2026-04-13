/**
 * Per-entity sliding window rate limiter.
 *
 * Tracks call timestamps per entity within a 60-second window and rejects
 * calls that would exceed the configured maximum.
 */

const WINDOW_MS = 60_000;

/** Result of a rate limit check. */
export interface RateLimitResult {
  /** Whether the call is allowed. */
  allowed: boolean;
  /** Milliseconds until the next call would be allowed, if rate limited. */
  retryAfterMs?: number;
}

/**
 * In-memory sliding window rate limiter.
 *
 * Each entity has a list of call timestamps. When checking, expired timestamps
 * (older than 60 seconds) are pruned, then the count is compared against the limit.
 */
export class RateLimiter {
  private readonly windows = new Map<string, number[]>();

  /**
   * Check whether a call to the given entity is allowed under the rate limit.
   * If allowed, the call is recorded in the window.
   *
   * @param entityId - The entity being called.
   * @param maxPerMinute - Maximum allowed calls per 60-second window.
   * @returns Whether the call is allowed, and retry-after if not.
   */
  checkRateLimit(entityId: string, maxPerMinute: number): RateLimitResult {
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    // Get or create the timestamp list for this entity
    let timestamps = this.windows.get(entityId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(entityId, timestamps);
    }

    // Prune expired timestamps
    const active = timestamps.filter((ts) => ts > windowStart);
    this.windows.set(entityId, active);

    if (active.length >= maxPerMinute) {
      // Rate limited -- calculate when the oldest active timestamp will expire
      const oldestActive = active[0];
      const retryAfterMs =
        oldestActive !== undefined ? oldestActive + WINDOW_MS - now : WINDOW_MS;
      return { allowed: false, retryAfterMs };
    }

    // Allowed -- record this call
    active.push(now);
    return { allowed: true };
  }

  /**
   * Remove all tracked timestamps for a specific entity.
   *
   * @param entityId - The entity to clear.
   */
  reset(entityId: string): void {
    this.windows.delete(entityId);
  }

  /** Remove all tracked timestamps for all entities. */
  resetAll(): void {
    this.windows.clear();
  }
}
