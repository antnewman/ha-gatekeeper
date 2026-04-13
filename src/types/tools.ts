/**
 * Types for MCP tool inputs and outputs.
 */

/** Common fields present in every tool call context. */
export interface ToolCallContext {
  /** UUID for this specific tool call. */
  requestId: string;
  /** Name of the tool being invoked. */
  toolName: string;
  /** Optional rationale provided by the LLM. */
  rationale?: string;
}

/** Input for entity-targeted tools. */
export interface EntityToolInput {
  entity_id: string;
}

/** Input for list_entities tool. */
export interface ListEntitiesInput {
  domain?: string;
  area?: string;
  label?: string;
}

/** Input for set_value tool. */
export interface SetValueInput {
  entity_id: string;
  attribute: string;
  value: number;
}

/** Input for send_command tool. */
export interface SendCommandInput {
  domain: string;
  service: string;
  entity_id?: string;
  service_data?: Record<string, unknown>;
}

/** Input for get_entity_history tool. */
export interface EntityHistoryInput {
  entity_id: string;
  /** ISO 8601 start time. */
  start_time?: string;
  /** ISO 8601 end time. */
  end_time?: string;
}

/** Generic tool result returned to the MCP client. */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
