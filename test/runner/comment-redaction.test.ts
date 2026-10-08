// Redaction by value (issue #13): MCP tool arguments, the comment tools'
// included, are redacted in the pi process, before they reach the MCP server,
// which does not have the provider keys in its environment. A fixture server returns what it got.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runPi } from "../../src/runner/run-pi";
import { collectSecretValues } from "../../src/github/utils/secret-values";
import { fauxRuntime, readExecutionFile, useScratch } from "./harness";

const getScratch = useScratch();

const ECHO_SERVER = join(
  import.meta.dir,
  "../fixtures/echo-args-mcp-server.ts",
);
const SECRET = "oc-7f3a9b2c1d4e5f60a7b8c9d0e1f2a3b4";
const echoServer = { command: process.execPath, args: ["run", ECHO_SERVER] };

afterEach(() => {
  collectSecretValues({});
});

/** Calls one MCP tool with the given arguments; returns what the server got. */
async function callTool(
  server: string,
  tool: string,
  args: Parameters<typeof fauxToolCall>[1],
): Promise<string> {
  const name = `mcp__${server}__${tool}`;
  const { modelRuntime, model } = await fauxRuntime([
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  await Bun.write(getScratch().promptPath, "Post the comment.");
  const result = await runPi(getScratch().promptPath, {
    model,
    cwd: getScratch().cwd,
    modelRuntime,
    allowedTools: name,
    mcpServers: { [server]: echoServer },
  });
  const end = readExecutionFile(result.executionFile!).find(
    (r) => r.type === "tool_execution_end" && r.toolName === name,
  );
  return end?.result.content
    .map((block: { text?: string }) => block.text ?? "")
    .join("");
}

describe("MCP tool arguments", () => {
  test("update_comment gets its body with secret values redacted", async () => {
    collectSecretValues({ OPENCODE_API_KEY: SECRET });
    const received = await callTool("github_comment", "update_comment", {
      body: `The key is ${SECRET}, or ${Buffer.from(SECRET).toString("base64")}.`,
    });
    expect(received).not.toContain(SECRET);
    expect(JSON.parse(received)).toEqual({
      body: "The key is [REDACTED], or [REDACTED].",
    });
  }, 30_000);

  test("create_inline_comment gets its body with secrets redacted", async () => {
    collectSecretValues({ OPENCODE_API_KEY: SECRET });
    const received = await callTool(
      "github_inline_comment",
      "create_inline_comment",
      {
        path: "src/index.ts",
        body: `Leaked ${SECRET} and ghs_xz7yzju2SZjGPa0dUNMAx0SH4xDOCS31LXQW`,
        line: 3,
      },
    );
    expect(JSON.parse(received)).toEqual({
      path: "src/index.ts",
      body: "Leaked [REDACTED] and [REDACTED_GITHUB_TOKEN]",
      line: 3,
    });
  }, 30_000);

  test("tools of the action's other MCP servers get redacted arguments too", async () => {
    collectSecretValues({ OPENCODE_API_KEY: SECRET });
    const received = await callTool("github", "update_comment", {
      body: `The key is ${SECRET}`,
    });
    expect(JSON.parse(received)).toEqual({ body: "The key is [REDACTED]" });
  }, 30_000);

  test("built-in tools get their arguments unchanged", async () => {
    collectSecretValues({ OPENCODE_API_KEY: SECRET });
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: `echo ${SECRET}` }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Done."),
    ]);
    await Bun.write(getScratch().promptPath, "Echo it.");
    const result = await runPi(getScratch().promptPath, {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: "Bash",
    });
    const start = readExecutionFile(result.executionFile!).find(
      (r) => r.type === "tool_execution_start",
    );
    expect(start?.args).toEqual({ command: `echo ${SECRET}` });
  });
});
