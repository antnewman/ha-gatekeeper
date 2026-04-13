/**
 * Meta tools: get_server_health.
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
}
