// The action's MCP servers (issue #9): registered through pi's SDK with
// `direct` exposure, checked through runPi() with pi's faux provider and a
// real stdio server (test/fixtures/echo-env-mcp-server.ts).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runPi, type RunnerOptions } from "../../src/runner/run-pi";
import { declaredToolNames } from "../pi-sdk/harness";
import { fauxRuntime, readExecutionFile, useScratch, rules } from "./harness";

const getScratch = useScratch();

const ECHO_SERVER = join(import.meta.dir, "../fixtures/echo-env-mcp-server.ts");
const TOOL = "mcp__echo__echo_env";

function echoServer(env: Record<string, string>) {
  return { command: process.execPath, args: ["run", ECHO_SERVER], env };
}

/**
 * Run a session in which the model calls the echo tool once per name. Returns
 * the tools declared in the first request and the text of each tool result.
 */
async function echo(
  names: string[],
  options: Pick<RunnerOptions, "mcpServers" | "allowedTools">,
) {
  let declared: string[] = [];
  const { modelRuntime, model } = await fauxRuntime([
    (context) => {
      declared = declaredToolNames(context);
      if (names.length === 0) return fauxAssistantMessage("Done.");
      return fauxAssistantMessage(
        names.map((name) => fauxToolCall(TOOL, { name })),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Done."),
  ]);
  const scratch = getScratch();

  const result = await runPi("Echo the variables.", {
    model,
    cwd: scratch.cwd,
    modelRuntime,
    allowedTools: rules(TOOL),
    ...options,
  });

  const results = readExecutionFile(result.executionFile!)
    .filter((r) => r.type === "tool_execution_end" && r.toolName === TOOL)
    .map((r) =>
      r.result.content.map((block: { text?: string }) => block.text).join(""),
    );
  return { declared, results };
}

describe("the action's MCP servers", () => {
  test("are declared to the model directly, and their tools run in the server", async () => {
    const { declared, results } = await echo(["ECHO_VALUE"], {
      mcpServers: { echo: echoServer({ ECHO_VALUE: "hello" }) },
    });

    expect(declared).toContain(TOOL);
    // direct exposure: no codemode or tool_search indirection.
    expect(declared).not.toContain("codemode");
    expect(declared).not.toContain("tool_search");
    expect(results).toEqual(["ECHO_VALUE=hello"]);
  }, 30_000);

  test("get env values literally, without pi's $VAR or !command expansion", async () => {
    const values = {
      DOLLAR: "$HOME",
      BRACES: "${HOME}",
      DOUBLE: "a$$b",
      COMMAND: `!touch ${join(getScratch().root, "pwned")}`,
    };

    const { results } = await echo(Object.keys(values), {
      mcpServers: { echo: echoServer(values) },
    });

    expect(results).toEqual(
      Object.entries(values).map(([name, value]) => `${name}=${value}`),
    );
    expect(existsSync(join(getScratch().root, "pwned"))).toBe(false);
  }, 30_000);

  test("cannot be replaced or added to by mcp.json in the repository or home directory", async () => {
    const { cwd } = getScratch();
    const fileConfig = JSON.stringify({
      mcpServers: {
        echo: echoServer({ ECHO_VALUE: "from mcp.json" }),
        extra: echoServer({}),
      },
    });
    await Bun.write(join(cwd, ".pi/mcp.json"), fileConfig);
    await Bun.write(join(process.env.HOME!, ".pi/agent/mcp.json"), fileConfig);

    const { declared, results } = await echo(["ECHO_VALUE"], {
      mcpServers: { echo: echoServer({ ECHO_VALUE: "from the action" }) },
    });

    expect(results).toEqual(["ECHO_VALUE=from the action"]);
    expect(declared).not.toContain("mcp__extra__echo_env");
  }, 30_000);

  test("are left out of the session when there are none", async () => {
    const { declared } = await echo([], {});

    expect(declared.some((name) => name.startsWith("mcp__"))).toBe(false);
  });
});
