// Issue #2, AC 3: one of this project's MCP servers, registered through the
// SDK (no mcp.json on disk), is declared to the model with `direct` exposure.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import {
  createFauxSession,
  declaredToolNames,
  toolExecutionEnds,
  type FauxSession,
} from "./harness";

const COMMENT_SERVER = join(
  import.meta.dir,
  "../../src/mcp/github-comment-server.ts",
);
const TOOL = "mcp__github_comment__update_comment";

let current: FauxSession | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("MCP server registered through the SDK", () => {
  test("is declared to the model and callable with direct exposure", async () => {
    let declaredTools: string[] = [];
    current = await createFauxSession({
      extensionFactories: [
        // Ignore every mcp.json; only servers registered below are used.
        createMcpExtension({
          loadConfig: () => ({ servers: [], errors: [] }),
          logPath: "/dev/null",
        }),
        (pi) => {
          pi.registerMcpServer("github_comment", {
            command: process.execPath,
            args: ["run", COMMENT_SERVER],
            // Stdio servers inherit the whole process env; `env` adds to it.
            // An empty token makes the call fail inside the server.
            env: { REPO_OWNER: "owner", REPO_NAME: "repo", GITHUB_TOKEN: "" },
            exposure: "direct",
          });
        },
      ],
      responses: [
        (context) => {
          declaredTools = declaredToolNames(context);
          return fauxAssistantMessage(
            fauxToolCall(TOOL, { body: "progress" }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("done"),
      ],
    });

    await current.session.bindExtensions({});
    await current.session.prompt("update the comment");

    expect(declaredTools).toContain(TOOL);
    expect(current.session.getActiveToolNames()).toContain(TOOL);

    // The call reaches the server process: without GITHUB_TOKEN it answers
    // with its own error, which proves the stdio round trip worked.
    const end = toolExecutionEnds(current).find((e) => e.toolName === TOOL);
    expect(end?.isError).toBe(true);
    expect(JSON.stringify(end?.result)).toContain(
      "GITHUB_TOKEN environment variable is required",
    );

    // Nothing was written to the agent dir (no mcp.json, no auth file).
    expect(existsSync(join(current.agentDir, "mcp.json"))).toBe(false);
  }, 30_000);
});

// The Runner must emit session_shutdown before session.dispose(): dispose()
// alone leaves the server process running, which keeps the action's process
// from exiting until the job times out.
describe("MCP server process lifetime", () => {
  let serverPid: number | undefined;
  afterEach(() => {
    if (serverPid !== undefined && isRunning(serverPid)) {
      process.kill(serverPid);
    }
    serverPid = undefined;
  });

  async function startSessionWithServer(): Promise<FauxSession> {
    const pidFile = join(tmpdir(), `mcp-pid-${process.pid}-${Date.now()}`);
    const session = await createFauxSession({
      extensionFactories: [
        createMcpExtension({
          loadConfig: () => ({ servers: [], errors: [] }),
          logPath: "/dev/null",
        }),
        (pi) => {
          pi.registerMcpServer("github_comment", {
            // Record the server's pid; exec keeps it the same process.
            command: "sh",
            args: [
              "-c",
              `echo $$ > ${pidFile}; exec ${process.execPath} run ${COMMENT_SERVER}`,
            ],
            env: { REPO_OWNER: "owner", REPO_NAME: "repo", GITHUB_TOKEN: "" },
            exposure: "direct",
          });
        },
      ],
      responses: [
        fauxAssistantMessage(fauxToolCall(TOOL, { body: "progress" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ],
    });
    await session.session.bindExtensions({});
    await session.session.prompt("update the comment");
    serverPid = Number(readFileSync(pidFile, "utf8").trim());
    rmSync(pidFile, { force: true });
    expect(isRunning(serverPid)).toBe(true);
    return session;
  }

  test("keeps running after session.dispose() alone", async () => {
    current = await startSessionWithServer();
    current.session.dispose();
    await Bun.sleep(500);
    expect(isRunning(serverPid!)).toBe(true);
  }, 30_000);

  test("exits on session_shutdown", async () => {
    current = await startSessionWithServer();
    await current.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(await exitsWithin(serverPid!, 5_000)).toBe(true);
  }, 30_000);
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}
