/**
 * Prometheus metrics registry and exporter.
 *
 * Exposes counters, histograms, and gauges for monitoring ha-gatekeeper.
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";
import type { Request, Response } from "express";

/**
 * Centralised metrics registry for ha-gatekeeper.
 *
 * Provides helper methods to record tool calls, durations, and system state.
 */
export class MetricsRegistry {
  readonly registry: Registry;

  readonly toolCallsTotal: Counter;
  readonly toolCallDuration: Histogram;
  readonly circuitBreakerState: Gauge;
  readonly rateLimitRejectionsTotal: Counter;
  readonly entityHallucinationsTotal: Counter;
  readonly confirmationTimeoutsTotal: Counter;
  readonly haConnectionState: Gauge;
  readonly policyDenialsTotal: Counter;

  /** Timestamp of the most recent tool call. */
  private _lastToolCallTime: Date | null = null;

  /** Sliding window of tool call error timestamps for error rate calculation. */
  private readonly _recentErrors: number[] = [];
  private readonly _recentCalls: number[] = [];

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.toolCallsTotal = new Counter({
      name: "ha_gatekeeper_tool_calls_total",
      help: "Total number of MCP tool calls",
      labelNames: ["tool", "tier", "decision"] as const,
      registers: [this.registry],
    });

    this.toolCallDuration = new Histogram({
      name: "ha_gatekeeper_tool_call_duration_seconds",
      help: "Tool call execution duration in seconds",
      labelNames: ["tool"] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.circuitBreakerState = new Gauge({
      name: "ha_gatekeeper_circuit_breaker_state",
      help: "Circuit breaker state: 0=closed, 1=half_open, 2=open",
      registers: [this.registry],
    });

    this.rateLimitRejectionsTotal = new Counter({
      name: "ha_gatekeeper_rate_limit_rejections_total",
      help: "Total rate limit rejections",
      labelNames: ["entity_id"] as const,
      registers: [this.registry],
    });

    this.entityHallucinationsTotal = new Counter({
      name: "ha_gatekeeper_entity_hallucinations_total",
      help: "Tool calls targeting non-existent entities",
      registers: [this.registry],
    });

    this.confirmationTimeoutsTotal = new Counter({
      name: "ha_gatekeeper_confirmation_timeouts_total",
      help: "Tier 2 confirmation timeouts",
      registers: [this.registry],
    });

    this.haConnectionState = new Gauge({
      name: "ha_gatekeeper_ha_connection_state",
      help: "Home Assistant connection state: 0=disconnected, 1=connected",
      registers: [this.registry],
    });

    this.policyDenialsTotal = new Counter({
      name: "ha_gatekeeper_policy_denials_total",
      help: "Total policy denials",
      labelNames: ["tier", "reason"] as const,
      registers: [this.registry],
    });
  }

  /** Get the timestamp of the most recent tool call, or null if none. */
  get lastToolCallTime(): Date | null {
    return this._lastToolCallTime;
  }

  /**
   * Get the error rate over the last hour (0.0 to 1.0).
   */
  getErrorRateLastHour(): number {
    const oneHourAgo = Date.now() - 3600000;
    const recentCalls = this._recentCalls.filter((t) => t > oneHourAgo);
    const recentErrors = this._recentErrors.filter((t) => t > oneHourAgo);

    if (recentCalls.length === 0) {
      return 0;
    }

    return recentErrors.length / recentCalls.length;
  }

  /**
   * Record a tool call with its outcome.
   *
   * @param tool - The tool name.
   * @param tier - The resolved policy tier.
   * @param decision - The policy decision outcome.
   */
  recordToolCall(tool: string, tier: number, decision: string): void {
    this.toolCallsTotal
      .labels(tool, String(tier), decision)
      .inc();

    this._lastToolCallTime = new Date();
    this._recentCalls.push(Date.now());

    if (decision.startsWith("denied")) {
      this._recentErrors.push(Date.now());
    }
  }

  /**
   * Record the duration of a tool call.
   *
   * @param tool - The tool name.
   * @param durationMs - Duration in milliseconds.
   */
  recordDuration(tool: string, durationMs: number): void {
    this.toolCallDuration.labels(tool).observe(durationMs / 1000);
  }

  /**
   * Update the circuit breaker state gauge.
   *
   * @param state - "closed" (0), "half_open" (1), or "open" (2).
   */
  setCircuitBreakerState(state: "closed" | "half_open" | "open"): void {
    const stateMap = { closed: 0, half_open: 1, open: 2 } as const;
    this.circuitBreakerState.set(stateMap[state]);
  }

  /**
   * Update the Home Assistant connection state gauge.
   *
   * @param connected - Whether HA is currently connected.
   */
  setHAConnectionState(connected: boolean): void {
    this.haConnectionState.set(connected ? 1 : 0);
  }

  /**
   * Record a rate limit rejection.
   *
   * @param entityId - The entity that was rate limited.
   */
  recordRateLimitRejection(entityId: string): void {
    this.rateLimitRejectionsTotal.labels(entityId).inc();
  }

  /** Record a tool call targeting a non-existent entity. */
  recordEntityHallucination(): void {
    this.entityHallucinationsTotal.inc();
  }

  /** Record a Tier 2 confirmation timeout. */
  recordConfirmationTimeout(): void {
    this.confirmationTimeoutsTotal.inc();
  }

  /**
   * Record a policy denial.
   *
   * @param tier - The tier that denied the action.
   * @param reason - The denial reason.
   */
  recordPolicyDenial(tier: number, reason: string): void {
    this.policyDenialsTotal.labels(String(tier), reason).inc();
  }

  /**
   * Return an Express request handler that serves Prometheus metrics.
   */
  getMetricsHandler(): (_req: Request, res: Response) => void {
    return (_req: Request, res: Response) => {
      void (async () => {
        const metrics = await this.registry.metrics();
        res.set("Content-Type", this.registry.contentType);
        res.send(metrics);
      })();
    };
  }
}
