import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { loadConfig } from "../../../src/config/loader.js";

const FIXTURES_DIR = resolve(import.meta.dirname, "../../fixtures");
const VALID_CONFIG = resolve(FIXTURES_DIR, "config.test.yaml");
const TEMP_DIR = resolve(import.meta.dirname, "../../.tmp");

describe("loadConfig", () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    delete process.env["TEST_TOKEN"];
  });

  it("loads and validates a valid config file", () => {
    const config = loadConfig(VALID_CONFIG);

    expect(config.homeassistant.url).toBe(
      "ws://localhost:8123/api/websocket",
    );
    expect(config.homeassistant.token).toBe("test-token-abc123");
    expect(config.server.port).toBe(8200);
    expect(config.server.transport).toBe("streamable-http");
    expect(config.policy.default_tier).toBe(3);
    expect(config.circuit_breaker.failure_threshold).toBe(3);
    expect(config.observability.audit_log.enabled).toBe(true);
  });

  it("resolves policy tiers correctly", () => {
    const config = loadConfig(VALID_CONFIG);

    // Tier 0 domains
    const tier0 = config.policy.tiers["0"];
    expect(tier0).toBeDefined();
    expect(tier0!.domains).toContain("sensor.*");

    // Tier 1 domains
    const tier1 = config.policy.tiers["1"];
    expect(tier1).toBeDefined();
    expect(tier1!.domains).toContain("light.*");

    // Tier 2 constraints
    const tier2 = config.policy.tiers["2"];
    expect(tier2).toBeDefined();
    expect(tier2!.constraints?.rate_limit?.max_calls_per_entity_per_minute).toBe(3);
    expect(tier2!.constraints?.confirmation?.timeout_seconds).toBe(30);

    // Tier 3 entities
    const tier3 = config.policy.tiers["3"];
    expect(tier3).toBeDefined();
    expect(tier3!.entities).toContain("switch.dangerous");

    // Entity overrides
    expect(config.policy.entity_overrides?.["light.nursery"]).toBe(2);
    expect(config.policy.entity_overrides?.["climate.office"]).toBe(1);
  });

  it("substitutes environment variables", () => {
    process.env["TEST_TOKEN"] = "env-token-xyz";

    const configContent = `
homeassistant:
  url: "ws://localhost:8123/api/websocket"
  token: "\${TEST_TOKEN}"
server:
  port: 8200
  host: "0.0.0.0"
  transport: "streamable-http"
policy:
  default_tier: 3
  tiers:
    0:
      description: "Read-only"
      domains:
        - "sensor.*"
circuit_breaker:
  health_check_interval_ms: 30000
  failure_threshold: 3
  recovery_threshold: 5
  timeout_ms: 10000
observability:
  audit_log:
    enabled: true
    database: "./data/audit.db"
    retention_days: 90
  metrics:
    enabled: false
    port: 9090
  health:
    enabled: false
    port: 8201
`;

    const configPath = resolve(TEMP_DIR, "env-config.yaml");
    writeFileSync(configPath, configContent);

    const config = loadConfig(configPath);
    expect(config.homeassistant.token).toBe("env-token-xyz");
  });

  it("throws when a referenced environment variable is not set", () => {
    const configContent = `
homeassistant:
  url: "ws://localhost:8123/api/websocket"
  token: "\${NONEXISTENT_VAR}"
server:
  port: 8200
  host: "0.0.0.0"
  transport: "streamable-http"
policy:
  default_tier: 3
  tiers: {}
circuit_breaker:
  health_check_interval_ms: 30000
  failure_threshold: 3
  recovery_threshold: 5
  timeout_ms: 10000
observability:
  audit_log:
    enabled: true
    database: "./data/audit.db"
    retention_days: 90
  metrics:
    enabled: false
    port: 9090
  health:
    enabled: false
    port: 8201
`;

    const configPath = resolve(TEMP_DIR, "bad-env-config.yaml");
    writeFileSync(configPath, configContent);

    expect(() => loadConfig(configPath)).toThrow("NONEXISTENT_VAR");
  });

  it("throws on invalid YAML", () => {
    const configPath = resolve(TEMP_DIR, "invalid.yaml");
    writeFileSync(configPath, "not: valid: yaml: [[[");

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("throws when required fields are missing", () => {
    const configContent = `
homeassistant:
  url: "ws://localhost:8123/api/websocket"
`;

    const configPath = resolve(TEMP_DIR, "incomplete.yaml");
    writeFileSync(configPath, configContent);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("throws when config file does not exist", () => {
    expect(() => loadConfig("/nonexistent/path/config.yaml")).toThrow();
  });

  it("rejects an invalid transport value", () => {
    const configContent = `
homeassistant:
  url: "ws://localhost:8123/api/websocket"
  token: "abc"
server:
  port: 8200
  host: "0.0.0.0"
  transport: "invalid-transport"
policy:
  default_tier: 3
  tiers: {}
circuit_breaker:
  health_check_interval_ms: 30000
  failure_threshold: 3
  recovery_threshold: 5
  timeout_ms: 10000
observability:
  audit_log:
    enabled: true
    database: "./data/audit.db"
    retention_days: 90
  metrics:
    enabled: false
    port: 9090
  health:
    enabled: false
    port: 8201
`;

    const configPath = resolve(TEMP_DIR, "bad-transport.yaml");
    writeFileSync(configPath, configContent);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("rejects an invalid default_tier value", () => {
    const configContent = `
homeassistant:
  url: "ws://localhost:8123/api/websocket"
  token: "abc"
server:
  port: 8200
  host: "0.0.0.0"
  transport: "streamable-http"
policy:
  default_tier: 5
  tiers: {}
circuit_breaker:
  health_check_interval_ms: 30000
  failure_threshold: 3
  recovery_threshold: 5
  timeout_ms: 10000
observability:
  audit_log:
    enabled: true
    database: "./data/audit.db"
    retention_days: 90
  metrics:
    enabled: false
    port: 9090
  health:
    enabled: false
    port: 8201
`;

    const configPath = resolve(TEMP_DIR, "bad-tier.yaml");
    writeFileSync(configPath, configContent);

    expect(() => loadConfig(configPath)).toThrow();
  });
});
