// Issue #2, AC 1-2: createAgentSession() runs under Bun, and the faux provider
// can script a session that includes a tool call.
import { afterEach, describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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

  // Why the harness uses fauxProvider(): the compat registerFauxProvider()
  // registers into pi-ai's global API registry, which a session's
  // ModelRuntime does not consult.
  test("a registerFauxProvider() model is unknown to ModelRuntime", async () => {
    const registration = registerFauxProvider();
    registration.setResponses([fauxAssistantMessage("unused")]);
    // Keep the default resource loader away from ~/.pi/agent and this repo.
    const dir = mkdtempSync(`${tmpdir()}/pi-sdk-test-`);
    try {
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: registration.getModel(),
        modelRuntime,
        noTools: "all",
        settingsManager: SettingsManager.inMemory(),
        sessionManager: SessionManager.inMemory(dir),
      });
      try {
        await expect(session.prompt("hi")).rejects.toThrow(
          "No API key found for faux",
        );
      } finally {
        session.dispose();
      }
    } finally {
      registration.unregister();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
