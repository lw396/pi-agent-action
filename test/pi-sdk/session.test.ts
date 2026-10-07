// Issue #2, AC 1-2: createAgentSession() runs under Bun, and the faux provider
// can script a session that includes a tool call.
import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createFauxSession,
  lastToolResultText,
  type FauxSession,
} from "./harness";

let current: FauxSession | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("pi SDK session under Bun", () => {
  test("completes a scripted session with a bash tool call", async () => {
    current = await createFauxSession({
      responses: [
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo spike" }), {
          stopReason: "toolUse",
        }),
        (context) =>
          fauxAssistantMessage(
            `tool said: ${lastToolResultText(context).trim()}`,
          ),
      ],
    });

    await current.session.prompt("run echo");

    expect(current.session.getLastAssistantText()).toBe("tool said: spike");
    const types = current.events.map((e) => e.type);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types).toContain("agent_settled");
  });
});
