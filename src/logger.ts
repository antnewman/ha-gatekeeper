/**
 * Pino logger instance for ha-gatekeeper.
 * Configured via the HA_SENTINEL_LOG_LEVEL environment variable.
 */

import pino from "pino";

const level = process.env["HA_SENTINEL_LOG_LEVEL"] ?? "info";

/** Shared logger instance. Use this instead of console.log throughout the codebase. */
export const logger = pino({
  name: "ha-gatekeeper",
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
});
