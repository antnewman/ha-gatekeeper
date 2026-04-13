/**
 * Configuration loader: reads YAML, substitutes environment variables,
 * merges defaults, and validates against the Zod schema.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { configSchema, type GatekeeperConfig } from "./schema.js";

/**
 * Substitute `${ENV_VAR}` patterns in a string with their environment variable values.
 *
 * @param value - The string potentially containing `${VAR}` placeholders.
 * @returns The string with all placeholders replaced.
 * @throws If a referenced environment variable is not set.
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(
        `Environment variable '${varName}' is referenced in config but not set`,
      );
    }
    return envValue;
  });
}

/**
 * Recursively walk an object and substitute environment variables in all string values.
 */
function substituteEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === "string") {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsDeep);
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Load, parse, and validate the ha-gatekeeper configuration file.
 *
 * @param configPath - Path to the YAML configuration file.
 * @returns The validated configuration object.
 * @throws If the file cannot be read, parsed, or fails validation.
 */
export function loadConfig(configPath: string): GatekeeperConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = parseYaml(raw);
  const substituted = substituteEnvVarsDeep(parsed);
  return configSchema.parse(substituted);
}
