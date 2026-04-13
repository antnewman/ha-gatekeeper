/**
 * Tool registry: registers all MCP tools with the server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HAClient } from "../../execution/ha-client.js";
import type { PolicyEngine } from "../../policy/engine.js";
import type { AuditLog } from "../../observability/audit-log.js";
import type { MetricsRegistry } from "../../observability/metrics.js";
import type { CircuitBreaker } from "../../execution/circuit-breaker.js";
import type { GatekeeperConfig } from "../../config/schema.js";
import { registerReadTools } from "./read-tools.js";
import { registerControlTools } from "./control-tools.js";
import { registerMonitoringTools } from "./monitoring-tools.js";
import { registerMetaTools } from "./meta-tools.js";

/** Dependencies shared across all tool handlers. */
export interface ToolDependencies {
  haClient: HAClient;
  policyEngine: PolicyEngine;
  auditLog: AuditLog;
  metrics: MetricsRegistry;
  circuitBreaker: CircuitBreaker;
  config: GatekeeperConfig;
}

/**
 * Register all MCP tools with the server.
 *
 * @param server - The McpServer instance.
 * @param deps - Shared runtime dependencies.
 */
export function registerAllTools(
  server: McpServer,
  deps: ToolDependencies,
): void {
  registerReadTools(server, deps);
  registerControlTools(server, deps);
  registerMonitoringTools(server, deps);
  registerMetaTools(server, deps);
}
