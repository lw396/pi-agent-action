import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  commandMatchesPattern,
  parseToolRules,
  ruleNamesTool,
  type ToolRule,
} from "./tool-rules";
import { findShellSyntax } from "./shell-syntax";

/**
 * pi's read-only built-in tools. Like Claude Code's read-only tools, they need
 * no rule in allowed_tools; a disallowed_tools rule still blocks them.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export type ToolPermissions = {
  allowed: ToolRule[];
  disallowed: ToolRule[];
};

/**
 * Parse the allowed_tools and disallowed_tools inputs. Throws on a rule the
 * action cannot enforce as written, so the run fails before the model starts.
 */
export function parseToolPermissions(
  allowedTools: string | undefined,
  disallowedTools: string | undefined,
): ToolPermissions {
  return {
    allowed: parseToolRules(allowedTools, "allowed_tools"),
    disallowed: parseToolRules(disallowedTools, "disallowed_tools"),
  };
}

const ONE_COMMAND_AT_A_TIME =
  "Run one simple command per call, without &&, ||, ;, |, &, newlines, $(), backticks, subshells or redirections.";

function blocked(reason: string): ToolCallEventResult {
  return { block: true, reason: `${reason} Do not retry this call.` };
}

/** Decide whether one tool call may run; undefined lets it run. */
export function checkToolCall(
  permissions: ToolPermissions,
  event: Pick<ToolCallEvent, "toolName" | "input">,
): ToolCallEventResult | undefined {
  const { toolName } = event;
  const input: Record<string, unknown> = event.input;
  const command =
    toolName === "bash" && typeof input.command === "string"
      ? input.command
      : undefined;
  // A pattern can only be checked against a single simple command.
  const shellSyntax =
    command !== undefined ? findShellSyntax(command) : undefined;
  const matches = (rule: ToolRule) =>
    rule.pattern === undefined ||
    (command !== undefined && commandMatchesPattern(command, rule.pattern));

  for (const rule of permissions.disallowed) {
    if (!ruleNamesTool(rule, toolName)) continue;
    if (rule.pattern !== undefined && shellSyntax) {
      return blocked(
        `This ${toolName} command uses shell syntax (${shellSyntax}), so it cannot be checked against the disallowed_tools rule '${rule.text}'. ${ONE_COMMAND_AT_A_TIME}`,
      );
    }
    if (matches(rule)) {
      return blocked(
        `${toolName} is blocked by the disallowed_tools rule '${rule.text}'.`,
      );
    }
  }

  if (READ_ONLY_TOOLS.has(toolName)) return undefined;

  const allowRules = permissions.allowed.filter((rule) =>
    ruleNamesTool(rule, toolName),
  );
  if (allowRules.some((rule) => rule.pattern === undefined)) return undefined;
  if (allowRules.length === 0) {
    return blocked(
      `${toolName} is not allowed: no allowed_tools rule permits it.`,
    );
  }
  const allowed = allowRules.map((rule) => rule.text).join(", ");
  if (shellSyntax) {
    return blocked(
      `This ${toolName} command uses shell syntax (${shellSyntax}). allowed_tools only permits these commands: ${allowed}. ${ONE_COMMAND_AT_A_TIME}`,
    );
  }
  if (allowRules.some(matches)) return undefined;
  return blocked(
    `This ${toolName} command does not match any allowed_tools rule. Allowed: ${allowed}.`,
  );
}

/**
 * The tool permissions extension: enforces the allowed_tools and
 * disallowed_tools inputs on every tool call, including calls one tool makes
 * through another (pi sends those through tool_call too). A blocked call is
 * not run; the model gets the reason as the call's error result.
 */
export function toolPermissionsExtension(
  permissions: ToolPermissions,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => checkToolCall(permissions, event));
  };
}
