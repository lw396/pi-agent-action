#!/usr/bin/env bun
// A stdio MCP server for Runner tests: its one tool returns the value of an
// environment variable the server was started with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-env", version: "1.0.0" });

server.tool(
  "echo_env",
  "Return the value of an environment variable",
  { name: z.string() },
  async ({ name }) => ({
    content: [{ type: "text", text: `${name}=${process.env[name] ?? ""}` }],
  }),
);

await server.connect(new StdioServerTransport());
