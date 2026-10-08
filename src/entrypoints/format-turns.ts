#!/usr/bin/env bun

import { readFileSync, existsSync } from "fs";
import { exit } from "process";
import { redactSecrets } from "../github/utils/sanitizer";

export type ToolUse = {
  type: string;
  name?: string;
  input?: Record<string, any>;
  id?: string;
};

export type ToolResult = {
  type: string;
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
};

/**
 * One record of the Runner's Execution file: pi's session header, a session
 * event (`message_end`, `tool_execution_end`, `agent_settled`, ...), or the
 * closing `session_stats` totals. See src/runner/run-pi.ts.
 */
export type ExecutionRecord = {
  type: string;
  [key: string]: any;
};

export type GroupedContent = {
  type: string;
  tools_count?: number;
  text_parts?: string[];
  tool_calls?: { tool_use: ToolUse; tool_result?: ToolResult }[];
  usage?: Record<string, any>;
  data?: ExecutionRecord;
};

export function detectContentType(content: any): string {
  const contentStr = String(content).trim();

  // Check for JSON
  if (contentStr.startsWith("{") && contentStr.endsWith("}")) {
    try {
      JSON.parse(contentStr);
      return "json";
    } catch {
      // Fall through
    }
  }

  if (contentStr.startsWith("[") && contentStr.endsWith("]")) {
    try {
      JSON.parse(contentStr);
      return "json";
    } catch {
      // Fall through
    }
  }

  // Check for code-like content
  const codeKeywords = [
    "def ",
    "class ",
    "import ",
    "from ",
    "function ",
    "const ",
    "let ",
    "var ",
  ];
  if (codeKeywords.some((keyword) => contentStr.includes(keyword))) {
    if (
      contentStr.includes("def ") ||
      contentStr.includes("import ") ||
      contentStr.includes("from ")
    ) {
      return "python";
    } else if (
      ["function ", "const ", "let ", "var ", "=>"].some((js) =>
        contentStr.includes(js),
      )
    ) {
      return "javascript";
    } else {
      return "python"; // default for code
    }
  }

  // Check for shell/bash output
  const shellIndicators = ["ls -", "cd ", "mkdir ", "rm ", "$ ", "# "];
  if (
    contentStr.startsWith("/") ||
    contentStr.includes("Error:") ||
    contentStr.startsWith("total ") ||
    shellIndicators.some((indicator) => contentStr.includes(indicator))
  ) {
    return "bash";
  }

  // Check for diff format
  if (
    contentStr.startsWith("@@") ||
    contentStr.includes("+++ ") ||
    contentStr.includes("--- ")
  ) {
    return "diff";
  }

  // Check for HTML/XML
  if (contentStr.startsWith("<") && contentStr.endsWith(">")) {
    return "html";
  }

  // Check for markdown
  const mdIndicators = ["# ", "## ", "### ", "- ", "* ", "```"];
  if (mdIndicators.some((indicator) => contentStr.includes(indicator))) {
    return "markdown";
  }

  // Default to plain text
  return "text";
}

export function formatResultContent(content: any): string {
  if (!content) {
    return "*(No output)*\n\n";
  }

  let contentStr: string;

  // Check if content is a list with "type": "text" structure
  try {
    let parsedContent: any;
    if (typeof content === "string") {
      parsedContent = JSON.parse(content);
    } else {
      parsedContent = content;
    }

    if (
      Array.isArray(parsedContent) &&
      parsedContent.length > 0 &&
      typeof parsedContent[0] === "object" &&
      parsedContent[0]?.type === "text"
    ) {
      // Keep every text block, not just the first: a tool result may split its
      // output across several, and dropping the rest silently loses findings,
      // file paths and follow-up instructions from the rendered summary. Blocks
      // of other types (for example images) are skipped. Tool output is
      // arbitrary, so `text` is not guaranteed to be a string.
      contentStr = parsedContent
        .filter((block: any) => block?.type === "text")
        .map((block: any) => String(block?.text || ""))
        .join("\n");
    } else {
      contentStr = String(content).trim();
    }
  } catch {
    contentStr = String(content).trim();
  }

  // Redact before truncating so a credential cannot be split at the cut and
  // slip past the final redaction pass.
  contentStr = redactSecrets(contentStr);

  // Truncate very long results
  if (contentStr.length > 3000) {
    contentStr = contentStr.substring(0, 2997) + "...";
  }

  // Detect content type
  const contentType = detectContentType(contentStr);

  // Handle JSON content specially - pretty print it
  if (contentType === "json") {
    try {
      // Try to parse and pretty print JSON
      const parsed = JSON.parse(contentStr);
      contentStr = JSON.stringify(parsed, null, 2);
    } catch {
      // Keep original if parsing fails
    }
  }

  // Format with appropriate syntax highlighting
  if (
    contentType === "text" &&
    contentStr.length < 100 &&
    !contentStr.includes("\n")
  ) {
    // Short text results don't need code blocks
    return `**→** ${contentStr}\n\n`;
  } else {
    return `**Result:**\n\`\`\`${contentType}\n${contentStr}\n\`\`\`\n\n`;
  }
}

/** A tool error as text. pi reports it as content blocks, like a result. */
function errorText(content: any): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => String(block?.text || ""))
    .join("\n");
}

export function formatToolWithResult(
  toolUse: ToolUse,
  toolResult?: ToolResult,
): string {
  const toolName = toolUse.name || "unknown_tool";
  const toolInput = toolUse.input || {};

  let result = `### 🔧 \`${toolName}\`\n\n`;

  // Add parameters if they exist and are not empty
  if (Object.keys(toolInput).length > 0) {
    result += "**Parameters:**\n```json\n";
    result += JSON.stringify(toolInput, null, 2);
    result += "\n```\n\n";
  }

  // Add result if available
  if (toolResult) {
    const content = toolResult.content || "";
    const isError = toolResult.is_error || false;

    if (isError) {
      result += `❌ **Error:** \`${errorText(content)}\`\n\n`;
    } else {
      result += formatResultContent(content);
    }
  }

  return result;
}

export function groupTurnsNaturally(data: ExecutionRecord[]): GroupedContent[] {
  const groupedContent: GroupedContent[] = [];
  const toolResultsMap = new Map<string, ToolResult>();

  // First pass: collect all tool results by tool call id
  for (const record of data) {
    if (record.type === "tool_execution_end" && record.toolCallId) {
      toolResultsMap.set(record.toolCallId, {
        type: "tool_result",
        tool_use_id: record.toolCallId,
        content: record.result?.content,
        is_error: record.isError,
      });
    }
  }

  let finalText: string[] = [];
  let failed = false;
  let sawSystemMessage = false;

  // Second pass: one group per finished message. message_end carries the
  // final message; message_start and turn_end repeat it.
  for (const record of data) {
    if (record.type !== "message_end") continue;
    const message = record.message || {};

    if (message.role === "system") {
      // The leading system message declares the tools the session starts
      // with; later ones change the set mid-run.
      if (!sawSystemMessage) {
        groupedContent.push({
          type: "system_init",
          tools_count: (message.toolsAdded || []).length,
        });
      }
      sawSystemMessage = true;
    } else if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: { tool_use: ToolUse; tool_result?: ToolResult }[] = [];

      for (const item of message.content || []) {
        if (item.type === "text") {
          textParts.push(item.text || "");
        } else if (item.type === "toolCall") {
          toolCalls.push({
            tool_use: {
              type: item.type,
              name: item.name,
              input: item.arguments,
              id: item.id,
            },
            tool_result: item.id ? toolResultsMap.get(item.id) : undefined,
          });
        }
      }

      if (textParts.length > 0 || toolCalls.length > 0) {
        groupedContent.push({
          type: "assistant_action",
          text_parts: textParts,
          tool_calls: toolCalls,
          usage: message.usage,
        });
      }
      // pi reports a provider error, after its own retries, as the stop
      // reason of the last assistant message (see sessionFailure in run-pi).
      failed =
        message.stopReason === "error" || message.stopReason === "aborted";
      finalText = failed
        ? [
            message.errorMessage ||
              `the model stopped with ${message.stopReason}`,
          ]
        : textParts;
    }
    // The prompt is the session's only user message and, as in Upstream's
    // report, is left out; tool results are taken from tool_execution_end.
  }

  // The Runner ends the file with the run's totals, as Claude Code ended its
  // output with a result message.
  const stats = data.findLast((record) => record.type === "session_stats");
  if (stats) {
    groupedContent.push({
      type: failed ? "final_error" : "final_result",
      text_parts: finalText,
      data: stats,
    });
  }

  return groupedContent;
}

export function formatGroupedContent(groupedContent: GroupedContent[]): string {
  let markdown = "## pi Agent Report\n\n";

  for (const item of groupedContent) {
    const itemType = item.type;

    if (itemType === "system_init") {
      markdown += `## 🚀 System Initialization\n\n**Available Tools:** ${item.tools_count} tools loaded\n\n---\n\n`;
    } else if (itemType === "assistant_action") {
      // Add text content first (if any) - no header needed
      for (const text of item.text_parts || []) {
        if (text.trim()) {
          markdown += `${text}\n\n`;
        }
      }

      // Add tool calls with their results
      for (const toolCall of item.tool_calls || []) {
        markdown += formatToolWithResult(
          toolCall.tool_use,
          toolCall.tool_result,
        );
      }

      // Add usage info if available
      const usage = item.usage;
      if (usage) {
        markdown += `*Token usage: ${inputTokens(usage)} input, ${usage.output || 0} output*\n\n`;
      }

      // Only add separator if this section had content
      if (
        (item.text_parts && item.text_parts.length > 0) ||
        (item.tool_calls && item.tool_calls.length > 0)
      ) {
        markdown += "---\n\n";
      }
    } else if (itemType === "final_result" || itemType === "final_error") {
      const stats = item.data || { type: "session_stats" };
      const tokens = stats.tokens || {};
      const cost = stats.cost || 0;
      const duration = stats.durationMs || 0;

      markdown +=
        itemType === "final_error"
          ? "## ❌ Error\n\n"
          : "## ✅ Final Result\n\n";
      for (const text of item.text_parts || []) {
        if (text.trim()) {
          markdown += `${text}\n\n`;
        }
      }
      markdown +=
        `**Turns:** ${stats.assistantMessages || 0} | ` +
        `**Tool calls:** ${stats.toolCalls || 0} | ` +
        `**Tokens:** ${inputTokens(tokens)} input (${tokens.cacheRead || 0} cache read, ${tokens.cacheWrite || 0} cache write), ${tokens.output || 0} output | ` +
        `**Cost:** $${cost.toFixed(4)} | **Duration:** ${(duration / 1000).toFixed(1)}s\n\n`;
    }
  }

  return markdown;
}

/** Input tokens of a pi usage record, cached ones included. */
function inputTokens(usage: Record<string, any>): number {
  return (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

export function formatTurnsFromData(data: ExecutionRecord[]): string {
  // Group turns naturally
  const groupedContent = groupTurnsNaturally(data);

  // Generate markdown
  const markdown = formatGroupedContent(groupedContent);

  // Runtime output may contain credentials that are not registered as
  // workflow secrets, so redact known formats before this gets published.
  return redactSecrets(markdown);
}

function main(): void {
  // Get the JSON file path from command line arguments
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: format-turns.ts <json-file>");
    exit(1);
  }

  const jsonFile = args[0];
  if (!jsonFile) {
    console.error("Error: No JSON file provided");
    exit(1);
  }

  if (!existsSync(jsonFile)) {
    console.error(`Error: ${jsonFile} not found`);
    exit(1);
  }

  try {
    // Read the JSON file
    const fileContent = readFileSync(jsonFile, "utf-8");
    const data: ExecutionRecord[] = JSON.parse(fileContent);

    // Print to stdout (so it can be captured by shell)
    console.log(formatTurnsFromData(data));
  } catch (error) {
    console.error(`Error processing file: ${error}`);
    exit(1);
  }
}

if (import.meta.main) {
  main();
}
