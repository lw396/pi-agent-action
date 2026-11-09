import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  error?: string;
  isError?: boolean;
};

/** `value` as the JSON text one tool call returns. */
export function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * A failed tool call. `error` is the raw message, as the tool result's error
 * field always had it; `text` is what the model reads, if it needs more.
 */
export function errorResult(error: unknown, text?: string): McpToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: text ?? `Error: ${message}` }],
    error: message,
    isError: true,
  };
}

/** Serve `server` over stdio until the process exits. */
export async function runStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    server.close();
  });
}
