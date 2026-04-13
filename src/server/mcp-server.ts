/**
 * MCP server setup, tool registration, and transport configuration.
 *
 * Creates a McpServer instance, registers all tools, and configures
 * either Streamable HTTP or stdio transport based on configuration.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { GatekeeperConfig } from "../config/schema.js";
import type { ToolDependencies } from "./tools/index.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "../logger.js";

/** Result of creating and starting the MCP server. */
export interface McpServerResult {
  server: McpServer;
  httpServer?: Server;
}

/**
 * Create, configure, and start the MCP server.
 *
 * @param config - The validated gatekeeper configuration.
 * @param deps - Runtime dependencies needed by the tool handlers.
 * @returns The MCP server and optional HTTP server (for Streamable HTTP transport).
 */
export async function createMcpServer(
  config: GatekeeperConfig,
  deps: ToolDependencies,
): Promise<McpServerResult> {
  const mcpServer = new McpServer(
    {
      name: "ha-gatekeeper",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register all tools
  registerAllTools(mcpServer, deps);

  if (config.server.transport === "stdio") {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    logger.info("MCP server started with stdio transport");
    return { server: mcpServer };
  }

  // Streamable HTTP transport
  const app = createMcpExpressApp({ host: config.server.host });

  app.all("/mcp", (req, res) => {
    const sessionMode = config.server.session_mode ?? "stateful";

    const transportOptions: Record<string, unknown> = {};
    if (sessionMode === "stateful") {
      transportOptions["sessionIdGenerator"] = () => randomUUID();
    }

    const transport = new StreamableHTTPServerTransport(
      transportOptions as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
    );

    void mcpServer.connect(transport as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport);
    void transport.handleRequest(req, res);
  });

  const httpServer = app.listen(config.server.port, config.server.host, () => {
    logger.info(
      { port: config.server.port, host: config.server.host },
      "MCP server started with Streamable HTTP transport",
    );
  });

  return { server: mcpServer, httpServer };
}
