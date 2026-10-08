#!/usr/bin/env bun
// A stdio MCP server for Runner tests, standing in for the comment servers:
// its tools return the arguments they were called with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-args", version: "1.0.0" });

const echo = async (args: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(args) }],
});

server.tool(
  "update_comment",
  "Return the arguments",
  { body: z.string() },
  echo,
);
server.tool(
  "create_inline_comment",
  "Return the arguments",
  { path: z.string(), body: z.string(), line: z.number().optional() },
  echo,
);

await server.connect(new StdioServerTransport());
