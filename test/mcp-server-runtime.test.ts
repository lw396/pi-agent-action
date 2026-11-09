// The tool result shape the action's MCP servers return: the model reads
// content.text, and the raw error message stays in the result's error field.
import { describe, expect, test } from "bun:test";
import { errorResult, jsonResult } from "../src/mcp/server-runtime";

describe("MCP tool results", () => {
  test("returns a value as indented JSON text", () => {
    expect(jsonResult({ ok: true })).toEqual({
      content: [{ type: "text", text: '{\n  "ok": true\n}' }],
    });
  });

  test("keeps the raw error message beside the text the model reads", () => {
    expect(errorResult(new Error("Validation Failed"))).toEqual({
      content: [{ type: "text", text: "Error: Validation Failed" }],
      error: "Validation Failed",
      isError: true,
    });
  });

  test("returns more text for the model while the error stays raw", () => {
    expect(
      errorResult(new Error("Not Found"), "Error creating comment: Not Found"),
    ).toEqual({
      content: [{ type: "text", text: "Error creating comment: Not Found" }],
      error: "Not Found",
      isError: true,
    });
  });
});
