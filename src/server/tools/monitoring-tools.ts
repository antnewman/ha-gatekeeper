/**
 * Monitoring tools: get_anomalies, get_policy_summary.
 */

/* eslint-disable @typescript-eslint/require-await -- MCP SDK ToolCallback requires async */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";
import { resolveTier } from "../../policy/tier-resolver.js";

const TIER_NAMES: Record<number, string> = {
  0: "Unrestricted",
  1: "Logged",
  2: "Confirmed",
  3: "Prohibited",
};

/**
 * Register monitoring tools with the MCP server.
 */
export function registerMonitoringTools(
  server: McpServer,
  deps: ToolDependencies,
): void {
  server.registerTool(
    "get_anomalies",
    {
      description:
        "Analyse the current home state and report anomalies: unavailable entities, sensors at extreme values, devices that have not updated recently.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const allEntities = deps.haClient.getAllEntities();
      const anomalies: Array<{
        entity_id: string;
        issue: string;
        state: string;
      }> = [];

      const now = Date.now();
      const staleThresholdMs = 24 * 60 * 60 * 1000; // 24 hours

      for (const entity of Object.values(allEntities)) {
        // Check for unavailable or unknown states
        if (entity.state === "unavailable" || entity.state === "unknown") {
          anomalies.push({
            entity_id: entity.entity_id,
            issue: `State is '${entity.state}'`,
            state: entity.state,
          });
          continue;
        }

        // Check for stale entities
        const lastUpdated = new Date(entity.last_updated).getTime();
        if (now - lastUpdated > staleThresholdMs) {
          const hoursStale = Math.floor(
            (now - lastUpdated) / (60 * 60 * 1000),
          );
          anomalies.push({
            entity_id: entity.entity_id,
            issue: `Not updated for ${String(hoursStale)} hours`,
            state: entity.state,
          });
        }

        // Check temperature sensors for extreme values
        const attrs = entity.attributes as Record<string, unknown>;
        if (
          entity.entity_id.startsWith("sensor.") &&
          attrs["device_class"] === "temperature"
        ) {
          const temp = parseFloat(entity.state);
          if (!isNaN(temp) && (temp < -20 || temp > 60)) {
            anomalies.push({
              entity_id: entity.entity_id,
              issue: `Extreme temperature reading: ${entity.state}`,
              state: entity.state,
            });
          }
        }
      }

      if (anomalies.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No anomalies detected. All entities are reporting normally.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { anomaly_count: anomalies.length, anomalies },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_policy_summary",
    {
      description:
        "Show the current policy tier assignments for all known entities.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const allEntities = deps.haClient.getAllEntities();
      const tierSummary: Record<
        string,
        Array<{ entity_id: string; tier: number; tier_name: string }>
      > = {
        "0": [],
        "1": [],
        "2": [],
        "3": [],
      };

      // Need the full config for tier resolution -- access it through the policy engine
      // For now, we can construct a summary from the entities
      for (const entity of Object.values(allEntities)) {
        const entityId = entity.entity_id;
        const tier = resolveTier(entityId, undefined, deps.config);
        const tierName = TIER_NAMES[tier] ?? "Unknown";

        const tierKey = String(tier);
        tierSummary[tierKey]?.push({
          entity_id: entityId,
          tier,
          tier_name: tierName,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { entity_count: Object.keys(allEntities).length, tiers: tierSummary },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
