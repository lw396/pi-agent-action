// The Runner loads pi's codemode extension, and `--tools +codemode` in
// pi_args turns the tool on. Pins what that relies on: the SDK does not load
// the extension on its own, the loaded tool stays off by default, a `tools`
// list of `"+codemode"` adds it to pi's default tools, and every tool a script
// calls goes through the tool_call hook, where the tool permissions extension
// can block it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createCodemodeExtension,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createFauxSession,
  declaredToolNames,
  lastToolResultText,
  type FauxSession,
} from "./harness";

let current: FauxSession | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("codemode", () => {
  test("is not active without the extension", async () => {
    current = await createFauxSession({
      responses: [],
      sessionOptions: { tools: ["+codemode"] },
    });
    expect(current.session.getActiveToolNames()).not.toContain("codemode");
  });

  test("is loaded but off by default", async () => {
    current = await createFauxSession({
      extensionFactories: [createCodemodeExtension()],
      responses: [],
    });
    expect(current.session.getActiveToolNames()).not.toContain("codemode");
  });

  test('a "+codemode" tools list keeps the default tools and adds codemode', async () => {
    let declared: string[] = [];
    current = await createFauxSession({
      extensionFactories: [createCodemodeExtension()],
      sessionOptions: { tools: ["+codemode"] },
      responses: [
        (context: TranscriptContext) => {
          declared = declaredToolNames(context);
          return fauxAssistantMessage("ok");
        },
      ],
    });
    await current.session.bindExtensions({});
    await current.session.prompt("go");

    expect(current.session.getActiveToolNames().sort()).toEqual(
      ["bash", "codemode", "edit", "read", "write"].sort(),
    );
    expect(declared).toEqual(
      expect.arrayContaining(["bash", "codemode", "read"]),
    );
  });

  test("tools a script calls go through tool_call, which can block them", async () => {
    const seen: string[] = [];
    const blockBash = (pi: ExtensionAPI) => {
      pi.on("tool_call", (event) => {
        seen.push(event.toolName);
        if (event.toolName === "bash") {
          return { block: true, reason: "bash is blocked" };
        }
        return undefined;
      });
    };
    let result = "";
    current = await createFauxSession({
      extensionFactories: [createCodemodeExtension(), blockBash],
      sessionOptions: { tools: ["+codemode"] },
      responses: [
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: 'await tools.bash({ command: "touch pwned" });',
          }),
          { stopReason: "toolUse" },
        ),
        (context: TranscriptContext) => {
          result = lastToolResultText(context);
          return fauxAssistantMessage("done");
        },
      ],
    });
    await current.session.bindExtensions({});
    await current.session.prompt("go");

    expect(seen).toEqual(["codemode", "bash"]);
    expect(result).toContain("bash is blocked");
    expect(existsSync(join(current.cwd, "pwned"))).toBe(false);
  });
});
