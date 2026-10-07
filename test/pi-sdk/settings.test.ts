// Issue #2, AC 5: the signature of SettingsManager.inMemory(), and whether it
// accepts arbitrary settings keys.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFauxSession, type FauxSession } from "./harness";

// The package index does not export the `Settings` type itself.
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

let current: FauxSession | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("SettingsManager.inMemory", () => {
  test("takes (settings?: Partial<Settings>, options?: { projectTrusted?: boolean })", () => {
    // Compile-time check of the signature; inMemory() needs no arguments.
    const factory: (
      settings?: Settings,
      options?: { projectTrusted?: boolean },
    ) => SettingsManager = SettingsManager.inMemory;
    expect(factory().getSettings()).toEqual({});
    expect(SettingsManager.inMemory.length).toBe(0);
  });

  test("keeps keys outside the Settings type at runtime", () => {
    // Partial<Settings> rejects unknown keys in an object literal, so callers
    // need a cast; the value is stored and returned unchanged.
    const manager = SettingsManager.inMemory({
      retry: { enabled: false },
      piAgentAction: { nested: { value: 1 } },
    } as Settings);
    expect(manager.getSettings()).toMatchObject({
      retry: { enabled: false },
      piAgentAction: { nested: { value: 1 } },
    });
    expect(manager.getRetryEnabled()).toBe(false);
  });

  test("applyOverrides() accepts unknown keys, but reload() discards overrides", async () => {
    const manager = SettingsManager.inMemory({ fromCreate: 1 } as Settings);
    manager.applyOverrides({ fromOverride: 2 } as Settings);
    expect(manager.getSettings()).toMatchObject({
      fromCreate: 1,
      fromOverride: 2,
    });

    manager.setDefaultThinkingLevel("low");
    await manager.flush();
    await manager.reload();

    // Values given to inMemory() and setters survive; overrides do not.
    expect(manager.getSettings()).toEqual({
      fromCreate: 1,
      defaultThinkingLevel: "low",
    } as Settings);
  });

  test("is what extensions read, and nothing reaches the agent dir or the repo", async () => {
    let seenByExtension: unknown;
    current = await createFauxSession({
      settings: { piAgentAction: "from-runner" },
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            seenByExtension = (pi.getSettings() as Record<string, unknown>)
              .piAgentAction;
          });
        },
      ],
      responses: [
        fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ],
    });
    // A repository-committed project settings file is not read either: the
    // in-memory manager has no project scope.
    await Bun.write(
      join(current.cwd, ".pi", "settings.json"),
      JSON.stringify({ defaultThinkingLevel: "high" }),
    );
    const settingsManager = current.session.settingsManager;
    await settingsManager.reload();

    await current.session.bindExtensions({});
    await current.session.prompt("go");

    // Setters write to the in-memory storage only.
    settingsManager.setDefaultThinkingLevel("low");
    await settingsManager.flush();

    expect(seenByExtension).toBe("from-runner");
    expect(settingsManager.getProjectSettings()).toEqual({});
    expect(settingsManager.drainErrors()).toEqual([]);
    const agentDirFiles = existsSync(current.agentDir)
      ? readdirSync(current.agentDir, { recursive: true })
      : [];
    expect(agentDirFiles).toEqual([]);
    expect(readdirSync(join(current.cwd, ".pi"))).toEqual(["settings.json"]);
  });
});
