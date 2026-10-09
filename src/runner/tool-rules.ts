import * as core from "@actions/core";
import { stripCommentLines } from "./pi-args";

/**
 * Parsing of the allowed_tools and disallowed_tools inputs.
 *
 * Rules use Claude Code's permission rule syntax, so a value copied from
 * Upstream's --allowedTools / --disallowedTools keeps working:
 *
 *   Bash                    every call to the tool
 *   Bash(git add:*)         bash commands that are `git add` or start with `git add `
 *   Bash(git status)        exactly that bash command
 *   mcp__github_ci__*       tool names may contain `*`
 *
 * Claude Code tool names are mapped to pi's (Bash → bash, Glob → find, ...).
 * Other names, such as mcp__* tools, are pi tool names already.
 */

export type ToolRule = {
  /** The rule as written in the input, for messages. */
  text: string;
  /** pi tool name; may contain `*`, which matches any characters. */
  tool: string;
  /** The `pattern` of `Tool(pattern)`; only bash rules have one. */
  pattern?: string;
};

/** Upstream (Claude Code) tool names, and the pi tool that does the same job. */
const UPSTREAM_TO_PI_TOOL: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  Grep: "grep",
  Glob: "find",
  LS: "ls",
  PowerShell: "powershell",
};

/** Upstream tools pi has no counterpart for: a rule on them has no effect. */
const UPSTREAM_ONLY_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "NotebookRead",
  "Task",
  "Agent",
  "TodoWrite",
  "TaskOutput",
  "KillTask",
  "KillShell",
  "BashOutput",
  "ExitPlanMode",
  "SlashCommand",
  "Skill",
  "AskUserQuestion",
]);

/**
 * Split an input into rule strings: separated by commas, spaces or newlines,
 * except inside the parentheses of a pattern. Lines starting with `#` are
 * comments, as in pi_args. Quotes around a rule, left over from copying a
 * shell-quoted --allowedTools value, are removed.
 */
function splitRules(text: string, inputName: string): string[] {
  const source = stripCommentLines(text);
  const rules: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  const flush = () => {
    if (current) rules.push(current);
    current = "";
  };
  for (const char of source) {
    if (depth > 0) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      current += char;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "(") {
        depth++;
        current += char;
      } else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "," || /\s/.test(char)) {
      flush();
    } else {
      if (char === "(") depth++;
      if (char === ")") {
        throw new Error(`Invalid ${inputName}: unmatched ')' in '${current})'`);
      }
      current += char;
    }
  }
  if (depth > 0) {
    throw new Error(`Invalid ${inputName}: unmatched '(' in '${current}'`);
  }
  flush();
  return rules;
}

function parseRule(text: string, inputName: string): ToolRule | undefined {
  const match = text.match(/^([^()]+?)(?:\((.*)\))?$/s);
  if (!match) {
    throw new Error(
      `Invalid ${inputName}: '${text}' is not a Tool or Tool(pattern) rule`,
    );
  }
  const name = match[1]!;
  const pattern = match[2];

  if (UPSTREAM_ONLY_TOOLS.has(name)) {
    core.warning(
      `${inputName}: ${name} is a Claude Code tool that pi does not have; the rule '${text}' has no effect.`,
    );
    return undefined;
  }
  const tool = UPSTREAM_TO_PI_TOOL[name] ?? name;

  if (pattern === undefined) return { text, tool };
  if (tool !== "bash") {
    // Upstream also takes path patterns for Read/Edit and domains for
    // WebFetch. Ignoring one would allow or deny more than the rule says.
    throw new Error(
      `Invalid ${inputName}: '${text}': only Bash rules can have a (pattern)`,
    );
  }
  if (!pattern.trim()) {
    throw new Error(`Invalid ${inputName}: '${text}' has an empty pattern`);
  }
  if (pattern === "*") return { text, tool }; // Bash(*) is the same as Bash
  return { text, tool, pattern };
}

/** Parse the allowed_tools or disallowed_tools input into rules. */
export function parseToolRules(
  text: string | undefined,
  inputName: string,
): ToolRule[] {
  if (!text?.trim()) return [];
  return splitRules(text, inputName)
    .map((rule) => parseRule(rule, inputName))
    .filter((rule): rule is ToolRule => rule !== undefined);
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "s");
}

/** Whether the rule names this tool. */
export function ruleNamesTool(rule: ToolRule, toolName: string): boolean {
  return rule.tool.includes("*")
    ? globToRegExp(rule.tool).test(toolName)
    : rule.tool === toolName;
}

/**
 * Whether a bash command matches a rule's pattern, as in Claude Code:
 * `*` matches any text, `prefix:*` is the same as `prefix *`, and a trailing
 * ` *` also matches the bare prefix (`git add *` matches `git add`).
 */
export function commandMatchesPattern(
  command: string,
  pattern: string,
): boolean {
  const normalized = pattern.endsWith(":*")
    ? `${pattern.slice(0, -2)} *`
    : pattern;
  const text = command.trim();
  if (globToRegExp(normalized).test(text)) return true;
  if (
    normalized.endsWith(" *") &&
    normalized.indexOf("*") === normalized.length - 1
  ) {
    return text === normalized.slice(0, -2);
  }
  return false;
}

/**
 * The tool names in an allowed_tools value, as written, without checking the
 * rules. Prepare uses them to decide which of the action's MCP servers to
 * start; the Runner checks the rules themselves.
 */
export function ruleToolNames(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return splitRules(text, "allowed_tools").map(
    (rule) => rule.match(/^[^(]*/)![0],
  );
}
