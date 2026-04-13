/**
 * Read tools: get_entity_state, list_entities, get_area_summary,
 * get_home_summary, get_entity_history.
 *
 * All read tools are Tier 0 (unrestricted) and annotated with readOnlyHint: true.
 */

/* eslint-disable @typescript-eslint/require-await -- MCP SDK ToolCallback requires async */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";

/**
 * Register all read tools with the MCP server.
 */
export function registerReadTools(
  server: McpServer,
  deps: ToolDependencies,
): void {
  server.registerTool(
    "get_entity_state",
    {
      description:
        "Get the current state and attributes of a single Home Assistant entity.",
      inputSchema: { entity_id: z.string().describe("The entity ID, e.g. 'light.living_room'") },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id }) => {
      const entity = deps.haClient.getEntityState(entity_id);
      if (!entity) {
        deps.metrics.recordEntityHallucination();
        return {
          content: [
            {
              type: "text" as const,
              text: `Entity '${entity_id}' does not exist in Home Assistant.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                entity_id: entity.entity_id,
                state: entity.state,
                attributes: entity.attributes,
                last_changed: entity.last_changed,
                last_updated: entity.last_updated,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_entities",
    {
      description:
        "List Home Assistant entities with optional filtering by domain, area, or label.",
      inputSchema: {
        domain: z
          .string()
          .optional()
          .describe("Filter by domain, e.g. 'light', 'sensor'"),
        area: z
          .string()
          .optional()
          .describe("Filter by area name"),
        label: z
          .string()
          .optional()
          .describe("Filter by label"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ domain }) => {
      const allEntities = deps.haClient.getAllEntities();
      let entities = Object.values(allEntities);

      if (domain) {
        entities = entities.filter((e) =>
          e.entity_id.startsWith(`${domain}.`),
        );
      }

      const summary = entities.map((e) => ({
        entity_id: e.entity_id,
        state: e.state,
        friendly_name:
          (e.attributes as Record<string, unknown>)["friendly_name"] ??
          e.entity_id,
      }));

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "get_area_summary",
    {
      description:
        "Get a summary of all devices and their states in a specific area.",
      inputSchema: { area: z.string().describe("The area name, e.g. 'Living Room'") },
      annotations: { readOnlyHint: true },
    },
    async ({ area }) => {
      const allEntities = deps.haClient.getAllEntities();
      const areaEntities = Object.values(allEntities).filter((e) => {
        const attrs = e.attributes as Record<string, unknown>;
        const entityArea =
          typeof attrs["area"] === "string" ? attrs["area"] : undefined;
        return entityArea?.toLowerCase() === area.toLowerCase();
      });

      if (areaEntities.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No entities found in area '${area}'. Note: area matching depends on entity attributes.`,
            },
          ],
        };
      }

      const summary = areaEntities.map((e) => ({
        entity_id: e.entity_id,
        state: e.state,
        friendly_name:
          (e.attributes as Record<string, unknown>)["friendly_name"] ??
          e.entity_id,
      }));

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "get_home_summary",
    {
      description:
        "Get a high-level summary of the entire home state, grouped by domain.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const allEntities = deps.haClient.getAllEntities();
      const byDomain: Record<
        string,
        { total: number; states: Record<string, number> }
      > = {};

      for (const entity of Object.values(allEntities)) {
        const dotIdx = entity.entity_id.indexOf(".");
        const domain =
          dotIdx > 0 ? entity.entity_id.slice(0, dotIdx) : "unknown";

        let domainEntry = byDomain[domain];
        if (!domainEntry) {
          domainEntry = { total: 0, states: {} };
          byDomain[domain] = domainEntry;
        }

        domainEntry.total++;
        domainEntry.states[entity.state] =
          (domainEntry.states[entity.state] ?? 0) + 1;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { entity_count: Object.keys(allEntities).length, domains: byDomain },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_entity_history",
    {
      description:
        "Get the state history for an entity over a time range.",
      inputSchema: {
        entity_id: z.string().describe("The entity ID"),
        start_time: z
          .string()
          .optional()
          .describe("ISO 8601 start time. Defaults to 24 hours ago."),
        end_time: z
          .string()
          .optional()
          .describe("ISO 8601 end time. Defaults to now."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id, start_time, end_time }) => {
      if (!deps.haClient.entityExists(entity_id)) {
        deps.metrics.recordEntityHallucination();
        return {
          content: [
            {
              type: "text" as const,
              text: `Entity '${entity_id}' does not exist in Home Assistant.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const startTime =
          start_time ?? new Date(Date.now() - 86400000).toISOString();
        const endTime = end_time ?? new Date().toISOString();

        const history = await deps.haClient.sendMessage<unknown>({
          type: "history/history_during_period",
          start_time: startTime,
          end_time: endTime,
          entity_ids: [entity_id],
          minimal_response: true,
          significant_changes_only: true,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(history, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to retrieve history for '${entity_id}': ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
