/**
 * Meta tools: get_server_health, verify_audit_integrity.
 */

/* eslint-disable @typescript-eslint/require-await -- MCP SDK ToolCallback requires async */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";

/**
 * Register meta tools with the MCP server.
 */
export function registerMetaTools(
  server: McpServer,
  deps: ToolDependencies,
): void {
  server.registerTool(
    "get_server_health",
    {
      description:
        "Return the health status of ha-gatekeeper: circuit breaker state, Home Assistant connection, entity count, and error rates.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const cbState = deps.circuitBreaker.getState();
      const haConnected = deps.haClient.isConnected;

      let status: string;
      if (cbState === "open" || !haConnected) {
        status = "unhealthy";
      } else if (cbState === "half_open") {
        status = "degraded";
      } else {
        status = "healthy";
      }

      const health = {
        status,
        circuit_breaker: cbState,
        ha_connected: haConnected,
        ha_entity_count: deps.haClient.entityCount,
        version: "0.1.0",
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(health, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "verify_audit_integrity",
    {
      description:
        "Verify the integrity of the audit log hash chain. Each audit entry is cryptographically chained to the previous one. This tool checks that no entries have been tampered with.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const result = deps.auditLog.verifyChain();

      const response: Record<string, unknown> = {
        valid: result.valid,
        total_rows: result.totalRows,
      };

      if (!result.valid && result.brokenAt !== undefined) {
        response["broken_at_row_id"] = result.brokenAt;
        response["message"] =
          `Audit chain integrity violation detected at row ${String(result.brokenAt)}. ` +
          `The hash chain is broken, indicating that data has been modified after it was written.`;
      } else {
        response["message"] =
          `Audit chain verified. All ${String(result.totalRows)} entries are intact and unmodified.`;
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    },
  );
}
