/**
 * ha-gatekeeper entry point.
 *
 * Loads configuration, initialises the logger, connects to Home Assistant,
 * and starts the MCP server.
 */

import { loadConfig } from "./config/loader.js";
import { logger } from "./logger.js";
import { HAClient } from "./execution/ha-client.js";

const CONFIG_PATH = process.env["HA_SENTINEL_CONFIG"] ?? "./config.yaml";

async function main(): Promise<void> {
  logger.info("ha-gatekeeper starting");

  // Load and validate configuration
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

  // Connect to Home Assistant
  const haClientOptions: {
    url: string;
    token: string;
    reconnectIntervalMs?: number;
    maxReconnectAttempts?: number;
  } = {
    url: config.homeassistant.url,
    token: config.homeassistant.token,
  };

  if (config.homeassistant.reconnect_interval_ms !== undefined) {
    haClientOptions.reconnectIntervalMs =
      config.homeassistant.reconnect_interval_ms;
  }
  if (config.homeassistant.max_reconnect_attempts !== undefined) {
    haClientOptions.maxReconnectAttempts =
      config.homeassistant.max_reconnect_attempts;
  }

  const haClient = new HAClient(haClientOptions);

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

  // TODO: Phase 4 -- initialise MCP server and register tools
  // TODO: Phase 3 -- initialise observability (audit log, metrics, health)

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("Shutting down ha-gatekeeper");
    haClient.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(
    { port: config.server.port, transport: config.server.transport },
    "ha-gatekeeper ready",
  );
}

void main();
