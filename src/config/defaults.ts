/**
 * Default configuration values for optional fields.
 */

/** Default values merged into the config before validation. */
export const CONFIG_DEFAULTS = {
  homeassistant: {
    reconnect_interval_ms: 5000,
    max_reconnect_attempts: 10,
  },
  server: {
    host: "0.0.0.0",
    port: 8200,
    transport: "streamable-http" as const,
    session_mode: "stateful" as const,
  },
  circuit_breaker: {
    health_check_interval_ms: 30000,
    failure_threshold: 3,
    recovery_threshold: 5,
    timeout_ms: 10000,
  },
  observability: {
    audit_log: {
      enabled: true,
      database: "./data/audit.db",
      retention_days: 90,
    },
    metrics: {
      enabled: true,
      port: 9090,
    },
    health: {
      enabled: true,
      port: 8201,
    },
  },
} as const;
