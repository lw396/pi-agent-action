import {
  createMcpExtension,
  type ExtensionFactory,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";

/** The action's MCP servers by name, in the shape of an mcp.json entry. */
export type McpServers = Record<string, McpServerConfig>;

/**
 * Escape a value for an MCP server's `env`, which pi reads as a template:
 * `$NAME` and `${NAME}` expand environment variables and a leading `!` runs
 * a shell command. `$$` is a literal `$`, and `$!` a literal `!`. Values such
 * as branch names come from the repository, so none may be expanded.
 */
function literalEnvValue(value: string): string {
  const escaped = value.replaceAll("$", "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function withLiteralEnv(config: McpServerConfig): McpServerConfig {
  if (!("command" in config) || !config.env) return config;
  const env = Object.fromEntries(
    Object.entries(config.env).map(([key, value]) => [
      key,
      literalEnvValue(value),
    ]),
  );
  return { ...config, env };
}

/**
 * The extensions that connect the action's MCP servers, or none when there are
 * no servers.
 *
 * Servers are registered through the SDK with `direct` exposure, so the model
 * sees their tools as it sees built-in tools, which is what the prompt's
 * instructions to call them assume. Nothing is written to disk: the GitHub
 * token in a server's env stays in memory. No mcp.json is read, neither
 * ~/.pi/agent/mcp.json nor the repository's .pi/mcp.json, so the checked-out
 * code cannot replace one of these servers (pi prefers a file's server to a
 * registered one of the same name) or add servers of its own.
 */
export function mcpServerExtensions(
  servers: McpServers,
  logPath: string,
): ExtensionFactory[] {
  if (Object.keys(servers).length === 0) return [];
  return [
    createMcpExtension({
      loadConfig: () => ({ servers: [], errors: [] }),
      logPath,
    }),
    (pi) => {
      for (const [name, config] of Object.entries(servers)) {
        pi.registerMcpServer(name, {
          ...withLiteralEnv(config),
          exposure: "direct",
        });
      }
    },
  ];
}
