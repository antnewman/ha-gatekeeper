/**
 * Zod schema for validating the ha-gatekeeper configuration file.
 */

import { z } from "zod";

const rangeClampBoundarySchema = z.object({
  min: z.number(),
  max: z.number(),
});

const rateLimitSchema = z.object({
  max_calls_per_entity_per_minute: z.number().int().positive(),
});

const confirmationSchema = z.object({
  method: z.enum(["notification", "webhook"]),
  timeout_seconds: z.number().int().positive(),
  notification_service: z.string().min(1),
  message_template: z.string().min(1),
});

const tierConstraintsSchema = z.object({
  rate_limit: rateLimitSchema.optional(),
  confirmation: confirmationSchema.optional(),
  range_clamp: z.record(z.string(), rangeClampBoundarySchema).optional(),
});

const tierConfigSchema = z.object({
  description: z.string().min(1),
  domains: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  actions: z.array(z.string()).optional(),
  constraints: tierConstraintsSchema.optional(),
});

const policySchema = z.object({
  default_tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  tiers: z.record(
    z.string().regex(/^[0-3]$/),
    tierConfigSchema,
  ),
  entity_overrides: z
    .record(
      z.string(),
      z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    )
    .optional(),
});

const homeAssistantSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  reconnect_interval_ms: z.number().int().positive().optional(),
  max_reconnect_attempts: z.number().int().positive().optional(),
});

const serverSchema = z.object({
  port: z.number().int().positive(),
  host: z.string().min(1),
  transport: z.enum(["streamable-http", "stdio"]),
  session_mode: z.enum(["stateful", "stateless"]).optional(),
});

const circuitBreakerSchema = z.object({
  health_check_interval_ms: z.number().int().positive(),
  failure_threshold: z.number().int().positive(),
  recovery_threshold: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
});

const auditLogSchema = z.object({
  enabled: z.boolean(),
  database: z.string().min(1),
  retention_days: z.number().int().positive(),
});

const metricsSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().positive(),
});

const healthSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().positive(),
});

const observabilitySchema = z.object({
  audit_log: auditLogSchema,
  metrics: metricsSchema,
  health: healthSchema,
});

/** Full configuration schema for ha-gatekeeper. */
export const configSchema = z.object({
  homeassistant: homeAssistantSchema,
  server: serverSchema,
  policy: policySchema,
  circuit_breaker: circuitBreakerSchema,
  observability: observabilitySchema,
});

/** The validated configuration type, inferred from the Zod schema. */
export type GatekeeperConfig = z.infer<typeof configSchema>;
