import { expect, test, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  formatTurnsFromData,
  detectContentType,
  formatResultContent,
  formatToolWithResult,
  type ToolUse,
  type ToolResult,
} from "../src/entrypoints/format-turns";
import type { ExecutionRecord } from "../src/runner/execution-file";

describe("detectContentType", () => {
  test("detects JSON objects", () => {
    expect(detectContentType('{"key": "value"}')).toBe("json");
    expect(detectContentType('{"number": 42}')).toBe("json");
  });

  test("detects JSON arrays", () => {
    expect(detectContentType("[1, 2, 3]")).toBe("json");
    expect(detectContentType('["a", "b"]')).toBe("json");
  });

  test("detects Python code", () => {
    expect(detectContentType("def hello():\n    pass")).toBe("python");
    expect(detectContentType("import os")).toBe("python");
    expect(detectContentType("from math import pi")).toBe("python");
  });

  test("detects JavaScript code", () => {
    expect(detectContentType("function test() {}")).toBe("javascript");
    expect(detectContentType("const x = 5")).toBe("javascript");
    expect(detectContentType("let y = 10")).toBe("javascript");
    expect(detectContentType("const fn = () => console.log()")).toBe(
      "javascript",
    );
  });

  test("detects bash/shell content", () => {
    expect(detectContentType("/usr/bin/test")).toBe("bash");
    expect(detectContentType("Error: command not found")).toBe("bash");
    expect(detectContentType("ls -la")).toBe("bash");
    expect(detectContentType("$ echo hello")).toBe("bash");
  });

  test("detects diff format", () => {
    expect(detectContentType("@@ -1,3 +1,3 @@")).toBe("diff");
    expect(detectContentType("+++ file.txt")).toBe("diff");
    expect(detectContentType("--- file.txt")).toBe("diff");
  });

  test("detects HTML/XML", () => {
    expect(detectContentType("<div>hello</div>")).toBe("html");
    expect(detectContentType("<xml>content</xml>")).toBe("html");
  });

  test("detects markdown", () => {
    expect(detectContentType("- List item")).toBe("markdown");
    expect(detectContentType("* List item")).toBe("markdown");
    expect(detectContentType("```code```")).toBe("markdown");
  });

  test("defaults to text", () => {
    expect(detectContentType("plain text")).toBe("text");
    expect(detectContentType("just some words")).toBe("text");
  });
});

describe("formatResultContent", () => {
  test("handles empty content", () => {
    expect(formatResultContent("")).toBe("*(No output)*\n\n");
    expect(formatResultContent(null)).toBe("*(No output)*\n\n");
    expect(formatResultContent(undefined)).toBe("*(No output)*\n\n");
  });

  test("formats short text without code blocks", () => {
    const result = formatResultContent("success");
    expect(result).toBe("**→** success\n\n");
  });

  test("formats long text with code blocks", () => {
    const longText =
      "This is a longer piece of text that should be formatted in a code block because it exceeds the short text threshold";
    const result = formatResultContent(longText);
    expect(result).toContain("**Result:**");
    expect(result).toContain("```text");
    expect(result).toContain(longText);
  });

  test("pretty prints JSON content", () => {
    const jsonContent = '{"key": "value", "number": 42}';
    const result = formatResultContent(jsonContent);
    expect(result).toContain("```json");
    expect(result).toContain('"key": "value"');
    expect(result).toContain('"number": 42');
  });

  test("truncates very long content", () => {
    const veryLongContent = "A".repeat(4000);
    const result = formatResultContent(veryLongContent);
    expect(result).toContain("...");
    // Should not contain the full long content
    expect(result.length).toBeLessThan(veryLongContent.length);
  });

  test("handles type:text structure", () => {
    const structuredContent = [{ type: "text", text: "Hello world" }];
    const result = formatResultContent(JSON.stringify(structuredContent));
    expect(result).toBe("**→** Hello world\n\n");
  });

  test("keeps every text block, not just the first", () => {
    const structuredContent = [
      { type: "text", text: "first line" },
      { type: "text", text: "second line" },
      { type: "text", text: "third line" },
    ];
    const result = formatResultContent(JSON.stringify(structuredContent));

    expect(result).toContain("first line");
    expect(result).toContain("second line");
    expect(result).toContain("third line");
  });

  test("keeps every text block when given an array directly", () => {
    const result = formatResultContent([
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
    ]);

    expect(result).toContain("alpha");
    expect(result).toContain("beta");
  });

  test("skips non-text blocks while keeping the text ones", () => {
    const structuredContent = [
      { type: "text", text: "visible" },
      { type: "image", source: { data: "ignored-binary" } },
      { type: "text", text: "also visible" },
    ];
    const result = formatResultContent(JSON.stringify(structuredContent));

    expect(result).toContain("visible");
    expect(result).toContain("also visible");
    expect(result).not.toContain("ignored-binary");
  });
});

describe("formatToolWithResult", () => {
  test("formats tool with parameters and result", () => {
    const toolUse: ToolUse = {
      type: "tool_use",
      name: "read_file",
      input: { file_path: "/path/to/file.txt" },
      id: "tool_123",
    };

    const toolResult: ToolResult = {
      type: "tool_result",
      tool_use_id: "tool_123",
      content: "File content here",
      is_error: false,
    };

    const result = formatToolWithResult(toolUse, toolResult);

    expect(result).toContain("### 🔧 `read_file`");
    expect(result).toContain("**Parameters:**");
    expect(result).toContain('"file_path": "/path/to/file.txt"');
    expect(result).toContain("**→** File content here");
  });

  test("formats tool with error result", () => {
    const toolUse: ToolUse = {
      type: "tool_use",
      name: "failing_tool",
      input: { param: "value" },
    };

    const toolResult: ToolResult = {
      type: "tool_result",
      content: "Permission denied",
      is_error: true,
    };

    const result = formatToolWithResult(toolUse, toolResult);

    expect(result).toContain("### 🔧 `failing_tool`");
    expect(result).toContain("❌ **Error:** `Permission denied`");
  });

  test("formats tool without parameters", () => {
    const toolUse: ToolUse = {
      type: "tool_use",
      name: "simple_tool",
    };

    const result = formatToolWithResult(toolUse);

    expect(result).toContain("### 🔧 `simple_tool`");
    expect(result).not.toContain("**Parameters:**");
  });

  test("handles unknown tool name", () => {
    const toolUse: ToolUse = {
      type: "tool_use",
    };

    const result = formatToolWithResult(toolUse);

    expect(result).toContain("### 🔧 `unknown_tool`");
  });
});

describe("detectContentType fallbacks", () => {
  test("falls back to text for malformed JSON objects", () => {
    // Looks like an object (starts with { ends with }) but does not parse.
    expect(detectContentType("{not valid json}")).toBe("text");
  });

  test("falls back to text for malformed JSON arrays", () => {
    // Looks like an array (starts with [ ends with ]) but does not parse.
    expect(detectContentType("[not, valid, json]")).toBe("text");
  });

  test("classifies non-python, non-js code keywords as python by default", () => {
    // Contains a code keyword ("class ") but matches neither the python-specific
    // nor the javascript-specific checks, so it hits the default branch.
    expect(detectContentType("class Foo {}")).toBe("python");
  });
});

describe("formatResultContent non-string input", () => {
  test("handles a numeric (non-string) result value", () => {
    const result = formatResultContent(42);
    expect(result).toContain("42");
  });

  test("handles a plain object (non-string, non-text-array) result value", () => {
    const result = formatResultContent({ status: "ok" });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("handles a text content block whose text field is not a string", () => {
    expect(() =>
      formatResultContent('[{"type":"text","text":{"foo":"bar"}}]'),
    ).not.toThrow();
    expect(formatResultContent('[{"type":"text","text":123}]')).toContain(
      "123",
    );
  });
});

// Execution file records, shaped like the Runner's (src/runner/run-pi.ts).
function assistantEnd(
  content: unknown[],
  extra: Record<string, unknown> = {},
): ExecutionRecord {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 300,
        cacheWrite: 50,
        totalTokens: 470,
        cost: { total: 0.0012 },
      },
      stopReason: "stop",
      ...extra,
    },
  };
}

function toolEnd(
  toolCallId: string,
  toolName: string,
  text: string,
  isError = false,
): ExecutionRecord {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: { content: [{ type: "text", text }] },
    isError,
  };
}

function sessionStats(): ExecutionRecord {
  return {
    type: "session_stats",
    sessionId: "session-1",
    userMessages: 1,
    assistantMessages: 3,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 7,
    tokens: {
      input: 1506,
      output: 21,
      cacheRead: 2920,
      cacheWrite: 1506,
      total: 5953,
    },
    cost: 0.03471,
    durationMs: 18760,
  };
}

describe("formatTurnsFromData", () => {
  test("renders only the heading for an empty session", () => {
    expect(formatTurnsFromData([])).toBe("## pi Agent Report\n\n");
  });

  test("renders an assistant response with its tool call, result and token usage", () => {
    const result = formatTurnsFromData([
      assistantEnd(
        [
          { type: "text", text: "Let me look at the file." },
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "src/index.ts" },
          },
        ],
        { stopReason: "toolUse" },
      ),
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "src/index.ts" },
      },
      toolEnd("call_1", "read", "export {};"),
    ]);

    expect(result).toBe(
      "## pi Agent Report\n\n" +
        "Let me look at the file.\n\n" +
        "### 🔧 `read`\n\n" +
        '**Parameters:**\n```json\n{\n  "path": "src/index.ts"\n}\n```\n\n' +
        "**→** export {};\n\n" +
        "*Token usage: 450 input, 20 output*\n\n" +
        "---\n\n",
    );
  });

  test("renders a failed tool call with its error text", () => {
    const result = formatTurnsFromData([
      assistantEnd(
        [
          {
            type: "toolCall",
            id: "call_1",
            name: "write",
            arguments: { path: "x.txt", content: "a" },
          },
        ],
        { stopReason: "toolUse" },
      ),
      toolEnd(
        "call_1",
        "write",
        "write is not allowed: no allowed_tools rule permits it.",
        true,
      ),
    ]);

    expect(result).toContain(
      "❌ **Error:** `write is not allowed: no allowed_tools rule permits it.`",
    );
  });

  test("ends with the final answer and the run's totals", () => {
    const result = formatTurnsFromData([
      assistantEnd([{ type: "text", text: "Removed the debug print." }]),
      { type: "agent_settled" },
      sessionStats(),
    ]);

    expect(result).toEndWith(
      "---\n\n" +
        "## ✅ Final Result\n\n" +
        "Removed the debug print.\n\n" +
        "**Turns:** 3 | **Tool calls:** 2 | " +
        "**Tokens:** 5932 input (2920 cache read, 1506 cache write), 21 output | " +
        "**Cost:** $0.0347 | **Duration:** 18.8s\n\n",
    );
  });

  test("ends with the model's error when the run failed", () => {
    const result = formatTurnsFromData([
      assistantEnd([{ type: "text", text: "Checking the tests." }]),
      assistantEnd([], {
        stopReason: "error",
        errorMessage: "429 rate limit exceeded",
      }),
      { type: "agent_settled" },
      sessionStats(),
    ]);

    expect(result).toContain(
      "## ❌ Error\n\n429 rate limit exceeded\n\n**Turns:** 3 |",
    );
    expect(result).not.toContain("Final Result");
  });

  test("starts with the tools the session began with, and leaves out the prompt", () => {
    const tool = (name: string) => ({ name, description: "", parameters: {} });
    const result = formatTurnsFromData([
      { type: "session", version: 3, id: "session-1", cwd: "/work" },
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "system",
          content: "",
          toolsAdded: [tool("read"), tool("bash"), tool("edit")],
        },
      },
      {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "The whole tag mode prompt" }],
        },
      },
      assistantEnd([{ type: "text", text: "Done." }]),
    ]);

    expect(result).toStartWith(
      "## pi Agent Report\n\n" +
        "## 🚀 System Initialization\n\n" +
        "**Available Tools:** 3 tools loaded\n\n" +
        "---\n\n" +
        "Done.\n\n",
    );
    expect(result).not.toContain("The whole tag mode prompt");
  });
});

describe("integration tests", () => {
  test("formats a recorded pi session correctly", () => {
    const jsonPath = join(__dirname, "fixtures", "sample-pi-events.json");
    const expectedPath = join(
      __dirname,
      "fixtures",
      "sample-pi-events-expected-output.md",
    );

    const records = JSON.parse(readFileSync(jsonPath, "utf-8"));
    const expectedOutput = readFileSync(expectedPath, "utf-8").trim();

    expect(formatTurnsFromData(records).trim()).toBe(expectedOutput);
  });
});

describe("credential redaction", () => {
  test("redacts credentials embedded in tool results", () => {
    const result = formatTurnsFromData([
      assistantEnd(
        [
          {
            type: "toolCall",
            id: "call_1",
            name: "bash",
            arguments: { command: "cat .env" },
          },
        ],
        { stopReason: "toolUse" },
      ),
      toolEnd(
        "call_1",
        "bash",
        "GITHUB_TOKEN=ghs_xz7yzju2SZjGPa0dUNMAx0SH4xDOCS31LXQW\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      ),
    ]);

    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result).toContain("[REDACTED_AWS_KEY_ID]");
    expect(result).not.toContain("ghs_xz7yzju2SZjGPa0dUNMAx0SH4xDOCS31LXQW");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("redacts credentials embedded in multi-line tool arguments", () => {
    const result = formatTurnsFromData([
      assistantEnd(
        [
          {
            type: "toolCall",
            id: "call_2",
            name: "write",
            arguments: {
              path: ".env",
              content:
                "AWS_ACCESS_KEY_ID=x\nGITHUB_TOKEN=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\n",
            },
          },
        ],
        { stopReason: "toolUse" },
      ),
    ]);

    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result).not.toContain("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");
  });

  test("redacts credentials wrapped in ANSI color codes", () => {
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefgh";
    const result = formatTurnsFromData([
      assistantEnd(
        [
          {
            type: "toolCall",
            id: "call_3",
            name: "bash",
            arguments: { command: "node print-config.js" },
          },
        ],
        { stopReason: "toolUse" },
      ),
      toolEnd(
        "call_3",
        "bash",
        `apiKey: \x1b[32m${key}\x1b[39m\nregion: us-east-1`,
      ),
    ]);

    expect(result).toContain("[REDACTED_ANTHROPIC_KEY]");
    expect(result).not.toContain(key);
  });

  test("redacts credentials in a tool error and in the model's error", () => {
    const key = `sk-proj-${"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789".repeat(3)}`;
    const result = formatTurnsFromData([
      assistantEnd(
        [
          {
            type: "toolCall",
            id: "call_4",
            name: "bash",
            arguments: { command: "./deploy" },
          },
        ],
        { stopReason: "toolUse" },
      ),
      toolEnd("call_4", "bash", `bad key ${key}`, true),
      assistantEnd([], {
        stopReason: "error",
        errorMessage: `401 invalid api key ${key}`,
      }),
      sessionStats(),
    ]);

    expect(result).not.toContain(key);
    expect(result).toContain("❌ **Error:** `bad key [REDACTED");
    expect(result).toContain("401 invalid api key [REDACTED");
  });
});
