/**
 * ha-gatekeeper entry point.
 *
 * Loads configuration, initialises all components in the correct order,
 * and starts the MCP server with full policy enforcement and observability.
 */

import { readFileSync } from "node:fs";
import { loadConfig } from "./config/loader.js";
import { logger } from "./logger.js";
import { HAClient } from "./execution/ha-client.js";
import { PolicyEngine } from "./policy/engine.js";
import { AuditLog } from "./observability/audit-log.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { createHealthServer } from "./observability/health.js";
import { CircuitBreaker } from "./execution/circuit-breaker.js";
import { ConfirmationManager } from "./policy/confirmation.js";
import { createMcpServer } from "./server/mcp-server.js";
import express from "express";

const CONFIG_PATH = process.env["HA_SENTINEL_CONFIG"] ?? "./config.yaml";
const startTime = new Date();

/** Read the version from package.json. */
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as Record<
      string,
      unknown
    >;
    return typeof pkg["version"] === "string" ? pkg["version"] : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const version = getVersion();
  logger.info({ version }, "ha-gatekeeper starting");

  // 1. Load and validate configuration
  let config;
  try {
    config = loadConfig(CONFIG_PATH);
    logger.info("Configuration loaded successfully");
  } catch (err: unknown) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to load configuration",
    );
    process.exit(1);
  }

  // 2. Connect to Home Assistant
  const haClient = new HAClient({
    url: config.homeassistant.url,
    token: config.homeassistant.token,
    ...(config.homeassistant.reconnect_interval_ms !== undefined && {
      reconnectIntervalMs: config.homeassistant.reconnect_interval_ms,
    }),
    ...(config.homeassistant.max_reconnect_attempts !== undefined && {
      maxReconnectAttempts: config.homeassistant.max_reconnect_attempts,
    }),
  });

  try {
    await haClient.connect();
    logger.info(
      { entityCount: haClient.entityCount },
      "Home Assistant connected",
    );
  } catch (err: unknown) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to connect to Home Assistant",
    );
    process.exit(1);
  }

  // 3. Initialise audit log
  const auditLog = new AuditLog(config.observability.audit_log.database);

  // Schedule daily audit log cleanup
  if (config.observability.audit_log.enabled) {
    const retentionDays = config.observability.audit_log.retention_days;
    setInterval(
      () => {
        auditLog.cleanup(retentionDays);
      },
      24 * 60 * 60 * 1000,
    );
  }

  // 4. Initialise metrics
  const metrics = new MetricsRegistry();
  metrics.setHAConnectionState(haClient.isConnected);

  // 5. Initialise policy engine
  const policyEngine = new PolicyEngine(config);

  // 6. Initialise circuit breaker
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: config.circuit_breaker.failure_threshold,
    recoveryThreshold: config.circuit_breaker.recovery_threshold,
    timeoutMs: config.circuit_breaker.timeout_ms,
    healthCheckIntervalMs: config.circuit_breaker.health_check_interval_ms,
  });

  circuitBreaker.setHealthCheck(async () => {
    try {
      await haClient.sendMessage({ type: "get_config" });
      return true;
    } catch {
      return false;
    }
  });

  // Update metrics when circuit breaker state changes
  const originalRecordSuccess = circuitBreaker.recordSuccess.bind(circuitBreaker);
  const originalRecordFailure = circuitBreaker.recordFailure.bind(circuitBreaker);
  circuitBreaker.recordSuccess = () => {
    originalRecordSuccess();
    metrics.setCircuitBreakerState(circuitBreaker.getState());
  };
  circuitBreaker.recordFailure = () => {
    originalRecordFailure();
    metrics.setCircuitBreakerState(circuitBreaker.getState());
  };

  // 7. Initialise confirmation manager
  const confirmationManager = new ConfirmationManager(haClient);

  // 8. Start MCP server
  const mcpResult = await createMcpServer(config, {
    haClient,
    policyEngine,
    auditLog,
    metrics,
    circuitBreaker,
    config,
  });

  // 9. Start observability endpoints
  let metricsServer: import("node:http").Server | undefined;
  if (config.observability.metrics.enabled) {
    const metricsApp = express();
    metricsApp.get("/metrics", metrics.getMetricsHandler());
    metricsServer = metricsApp.listen(
      config.observability.metrics.port,
      () => {
        logger.info(
          { port: config.observability.metrics.port },
          "Prometheus metrics endpoint started",
        );
      },
    );
  }

  let healthServer: import("node:http").Server | undefined;
  if (config.observability.health.enabled) {
    healthServer = createHealthServer(config.observability.health.port, {
      haClient,
      circuitBreaker,
      startTime,
      version,
    });
  }

  // 10. Start confirmation webhook server
  // Use a port offset from the main server port for the webhook
  const webhookPort = config.server.port + 1;
  confirmationManager.startWebhookServer(webhookPort);

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("Shutting down ha-gatekeeper");

    confirmationManager.destroy();
    circuitBreaker.destroy();
    auditLog.close();
    haClient.disconnect();

    if (mcpResult.httpServer) {
      mcpResult.httpServer.close();
    }
    if (metricsServer) {
      metricsServer.close();
    }
    if (healthServer) {
      healthServer.close();
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(
    {
      port: config.server.port,
      transport: config.server.transport,
      entityCount: haClient.entityCount,
      version,
    },
    "ha-gatekeeper ready",
  );
}

void main();
