/**
 * Control tools: turn_on, turn_off, toggle, set_value, activate_scene, send_command.
 *
 * Each tool validates the entity, evaluates policy, and if permitted,
 * executes the action through the circuit breaker with state capture.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";
import type { AuditLogEntry } from "../../types/audit.js";
import type { PolicyDecisionKind, PolicyTier } from "../../types/policy.js";
import {
  captureStateBefore,
  captureStateAfter,
  compareStates,
} from "../../execution/state-capture.js";
import { CircuitBreakerOpenError } from "../../execution/circuit-breaker.js";
import { logger } from "../../logger.js";

/**
 * Extract the domain from an entity ID.
 */
function getDomain(entityId: string): string {
  const dotIdx = entityId.indexOf(".");
  return dotIdx > 0 ? entityId.slice(0, dotIdx) : entityId;
}

/**
 * Build an AuditLogEntry, only including optional fields that have a defined value.
 * Accepts `undefined` values and strips them to satisfy `exactOptionalPropertyTypes`.
 */
function buildAuditEntry(
  required: {
    timestamp: string;
    request_id: string;
    tool_name: string;
    policy_tier: PolicyTier;
    policy_decision: PolicyDecisionKind;
  },
  optional: {
    entity_id?: string | undefined;
    action?: string | undefined;
    parameters?: string | undefined;
    clamped_from?: string | undefined;
    clamped_to?: string | undefined;
    state_before?: string | undefined;
    state_after?: string | undefined;
    execution_duration_ms?: number | undefined;
    error?: string | undefined;
  } = {},
): AuditLogEntry {
  const entry: AuditLogEntry = { ...required };

  if (optional.entity_id !== undefined) entry.entity_id = optional.entity_id;
  if (optional.action !== undefined) entry.action = optional.action;
  if (optional.parameters !== undefined) entry.parameters = optional.parameters;
  if (optional.clamped_from !== undefined) entry.clamped_from = optional.clamped_from;
  if (optional.clamped_to !== undefined) entry.clamped_to = optional.clamped_to;
  if (optional.state_before !== undefined) entry.state_before = optional.state_before;
  if (optional.state_after !== undefined) entry.state_after = optional.state_after;
  if (optional.execution_duration_ms !== undefined) entry.execution_duration_ms = optional.execution_duration_ms;
  if (optional.error !== undefined) entry.error = optional.error;

  return entry;
}

/**
 * Execute a control action with full policy evaluation, circuit breaker,
 * state capture, and audit logging.
 */
async function executeControlAction(
  deps: ToolDependencies,
  toolName: string,
  entityId: string,
  service: string,
  serviceData?: Record<string, unknown>,
  numericValues?: Record<string, number>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const requestId = randomUUID();
  const domain = getDomain(entityId);
  const action = `${domain}.${service}`;
  const startTime = Date.now();

  // Validate entity exists
  if (!deps.haClient.entityExists(entityId)) {
    deps.metrics.recordEntityHallucination();
    return {
      content: [
        {
          type: "text" as const,
          text: `Entity '${entityId}' does not exist in Home Assistant.`,
        },
      ],
      isError: true,
    };
  }

  // Evaluate policy
  const evalParams: { entityId: string; action: string; numericValues?: Record<string, number> } = {
    entityId,
    action,
  };
  if (numericValues !== undefined) {
    evalParams.numericValues = numericValues;
  }

  const decision = deps.policyEngine.evaluate(evalParams);

  deps.metrics.recordToolCall(toolName, decision.tier, decision.decision);

  if (!decision.permitted) {
    deps.metrics.recordPolicyDenial(decision.tier, decision.decision);

    if (decision.decision === "denied_rate_limit") {
      deps.metrics.recordRateLimitRejection(entityId);
    }

    deps.auditLog.write(
      buildAuditEntry(
        {
          timestamp: new Date().toISOString(),
          request_id: requestId,
          tool_name: toolName,
          policy_tier: decision.tier,
          policy_decision: decision.decision,
        },
        {
          entity_id: entityId,
          action,
          parameters: serviceData ? JSON.stringify(serviceData) : undefined,
        },
      ),
    );

    return {
      content: [{ type: "text" as const, text: decision.reason }],
      isError: true,
    };
  }

  // Apply clamped values to service data if any
  const effectiveData: Record<string, unknown> = { ...serviceData };
  if (decision.clampedTo) {
    for (const [attr, value] of Object.entries(decision.clampedTo)) {
      const parts = attr.split(".");
      const attrName = parts.length > 1 ? parts[parts.length - 1] ?? attr : attr;
      effectiveData[attrName] = value;
    }
  }

  // Capture state before
  const stateBefore = captureStateBefore(deps.haClient, entityId);

  // Build service call -- only include service_data if non-empty
  const hasData = Object.keys(effectiveData).length > 0;

  // Execute through circuit breaker
  try {
    await deps.circuitBreaker.execute(async () => {
      const call: { domain: string; service: string; service_data?: Record<string, unknown>; target: { entity_id: string } } = {
        domain,
        service,
        target: { entity_id: entityId },
      };
      if (hasData) {
        call.service_data = effectiveData;
      }
      await deps.haClient.callService(call);
    });
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage =
      err instanceof CircuitBreakerOpenError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    deps.auditLog.write(
      buildAuditEntry(
        {
          timestamp: new Date().toISOString(),
          request_id: requestId,
          tool_name: toolName,
          policy_tier: decision.tier,
          policy_decision: decision.decision,
        },
        {
          entity_id: entityId,
          action,
          parameters: JSON.stringify(effectiveData),
          state_before: stateBefore ? JSON.stringify(stateBefore) : undefined,
          execution_duration_ms: durationMs,
          error: errorMessage,
          clamped_from: decision.clampedFrom ? JSON.stringify(decision.clampedFrom) : undefined,
          clamped_to: decision.clampedTo ? JSON.stringify(decision.clampedTo) : undefined,
        },
      ),
    );

    deps.metrics.recordDuration(toolName, durationMs);

    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to execute '${action}' on '${entityId}': ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }

  // Capture state after
  const stateAfter = await captureStateAfter(deps.haClient, entityId);
  const durationMs = Date.now() - startTime;
  const stateComparison = compareStates(entityId, stateBefore, stateAfter);

  deps.metrics.recordDuration(toolName, durationMs);

  // Audit log
  deps.auditLog.write(
    buildAuditEntry(
      {
        timestamp: new Date().toISOString(),
        request_id: requestId,
        tool_name: toolName,
        policy_tier: decision.tier,
        policy_decision: decision.decision,
      },
      {
        entity_id: entityId,
        action,
        parameters: JSON.stringify(effectiveData),
        state_before: stateBefore ? JSON.stringify(stateBefore) : undefined,
        state_after: stateAfter ? JSON.stringify(stateAfter) : undefined,
        execution_duration_ms: durationMs,
        clamped_from: decision.clampedFrom ? JSON.stringify(decision.clampedFrom) : undefined,
        clamped_to: decision.clampedTo ? JSON.stringify(decision.clampedTo) : undefined,
      },
    ),
  );

  const resultParts: string[] = [
    `Action '${action}' executed on '${entityId}'.`,
  ];

  if (stateComparison.stateChanged) {
    resultParts.push(
      `State changed: '${stateBefore?.state ?? "unknown"}' -> '${stateAfter?.state ?? "unknown"}'.`,
    );
  }

  if (decision.clampedTo) {
    resultParts.push(
      `Note: values were clamped. Requested: ${JSON.stringify(decision.clampedFrom)}, applied: ${JSON.stringify(decision.clampedTo)}.`,
    );
  }

  logger.info(
    {
      requestId,
      tool: toolName,
      entityId,
      action,
      tier: decision.tier,
      durationMs,
      stateChanged: stateComparison.stateChanged,
    },
    "Control action executed",
  );

  return {
    content: [{ type: "text" as const, text: resultParts.join(" ") }],
  };
}

/**
 * Register all control tools with the MCP server.
 */
export function registerControlTools(
  server: McpServer,
  deps: ToolDependencies,
): void {
  server.registerTool(
    "turn_on",
    {
      description: "Turn on a light, switch, fan, media player, or other device.",
      inputSchema: {
        entity_id: z.string().describe("The entity ID to turn on"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ entity_id }) =>
      executeControlAction(deps, "turn_on", entity_id, "turn_on"),
  );

  server.registerTool(
    "turn_off",
    {
      description: "Turn off a light, switch, fan, media player, or other device.",
      inputSchema: {
        entity_id: z.string().describe("The entity ID to turn off"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ entity_id }) =>
      executeControlAction(deps, "turn_off", entity_id, "turn_off"),
  );

  server.registerTool(
    "toggle",
    {
      description: "Toggle the state of a light, switch, fan, or other device.",
      inputSchema: {
        entity_id: z.string().describe("The entity ID to toggle"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ entity_id }) =>
      executeControlAction(deps, "toggle", entity_id, "toggle"),
  );

  server.registerTool(
    "set_value",
    {
      description:
        "Set a numeric value on a device: brightness, temperature, volume, position, etc.",
      inputSchema: {
        entity_id: z.string().describe("The entity ID"),
        attribute: z
          .string()
          .describe(
            "The attribute to set, e.g. 'brightness', 'temperature', 'volume_level', 'position'",
          ),
        value: z.number().describe("The numeric value to set"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ entity_id, attribute, value }) => {
      const domain = getDomain(entity_id);
      const clampKey = `${domain}.${attribute}`;

      const serviceMap: Record<string, { service: string; dataKey: string }> = {
        brightness: { service: "turn_on", dataKey: "brightness" },
        temperature: { service: "set_temperature", dataKey: "temperature" },
        target_temp_high: { service: "set_temperature", dataKey: "target_temp_high" },
        target_temp_low: { service: "set_temperature", dataKey: "target_temp_low" },
        volume_level: { service: "volume_set", dataKey: "volume_level" },
        position: { service: "set_cover_position", dataKey: "position" },
      };

      const mapping = serviceMap[attribute];
      const service = mapping?.service ?? "turn_on";
      const dataKey = mapping?.dataKey ?? attribute;

      return executeControlAction(
        deps,
        "set_value",
        entity_id,
        service,
        { [dataKey]: value },
        { [clampKey]: value },
      );
    },
  );

  server.registerTool(
    "activate_scene",
    {
      description: "Activate a predefined Home Assistant scene.",
      inputSchema: {
        entity_id: z
          .string()
          .describe("The scene entity ID, e.g. 'scene.movie_night'"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ entity_id }) =>
      executeControlAction(deps, "activate_scene", entity_id, "turn_on"),
  );

  server.registerTool(
    "send_command",
    {
      description:
        "Send a domain-specific command to Home Assistant, e.g. media_player.play_media.",
      inputSchema: {
        domain: z.string().describe("The service domain, e.g. 'media_player'"),
        service: z.string().describe("The service name, e.g. 'play_media'"),
        entity_id: z
          .string()
          .optional()
          .describe("The target entity ID, if applicable"),
        service_data: z
          .record(z.unknown())
          .optional()
          .describe("Additional service data"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ domain, service, entity_id, service_data }) => {
      const targetEntity = entity_id ?? `${domain}.unknown`;

      return executeControlAction(
        deps,
        "send_command",
        targetEntity,
        service,
        service_data ?? {},
      );
    },
  );
}
