/**
 * Health check endpoint.
 *
 * Reports connection status, circuit breaker state, entity count, and uptime.
 * Runs on a separate Express server to keep health checks independent of the MCP transport.
 */

import express from "express";
import type { Server } from "node:http";
import { logger } from "../logger.js";
import type { HAClient } from "../execution/ha-client.js";
import type { CircuitBreaker } from "../execution/circuit-breaker.js";

/** Dependencies required by the health check endpoint. */
export interface HealthDependencies {
  haClient: HAClient;
  circuitBreaker: CircuitBreaker;
  startTime: Date;
  version: string;
}

/** Health check response shape. */
export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  circuit_breaker: "closed" | "half_open" | "open";
  ha_connected: boolean;
  ha_entity_count: number;
  uptime_seconds: number;
  version: string;
}

/**
 * Create and start the health check HTTP server.
 *
 * @param port - The port to listen on.
 * @param deps - The runtime dependencies for building the health response.
 * @returns The HTTP server instance (for cleanup on shutdown).
 */
export function createHealthServer(
  port: number,
  deps: HealthDependencies,
): Server {
  const app = express();

  app.get("/health", (_req, res) => {
    const cbState = deps.circuitBreaker.getState();
    const haConnected = deps.haClient.isConnected;

    let status: HealthResponse["status"];
    if (cbState === "open" || !haConnected) {
      status = "unhealthy";
    } else if (cbState === "half_open") {
      status = "degraded";
    } else {
      status = "healthy";
    }

    const response: HealthResponse = {
      status,
      circuit_breaker: cbState,
      ha_connected: haConnected,
      ha_entity_count: deps.haClient.entityCount,
      uptime_seconds: Math.floor(
        (Date.now() - deps.startTime.getTime()) / 1000,
      ),
      version: deps.version,
    };

    const statusCode = status === "healthy" ? 200 : 503;
    res.status(statusCode).json(response);
  });

  const server = app.listen(port, () => {
    logger.info({ port }, "Health check endpoint started");
  });

  return server;
}
