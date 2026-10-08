import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../github/utils/sanitizer";

/**
 * Every MCP server the action registers talks to GitHub (comments, inline
 * comments, commits, the official github server), and pi_args cannot add
 * others, so any MCP tool argument may end up published. The servers redact
 * some of what they post too, but their environment lacks the provider keys,
 * so redaction by value only works here, in the pi process.
 */
const MCP_TOOL_PREFIX = "mcp__";

function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item)]),
    );
  }
  return value;
}

/**
 * Redact every string argument of an MCP tool call, the comment tools'
 * included, before the call reaches its server. pi lets tool_call handlers change the input in
 * place.
 */
export function commentRedactionExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (!event.toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
      const input: Record<string, unknown> = event.input;
      for (const [key, value] of Object.entries(input)) {
        input[key] = redactStrings(value);
      }
      return undefined;
    });
  };
}
