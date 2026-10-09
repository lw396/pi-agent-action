// Runner seam (issue #7): runPi() driven end to end by pi's faux provider.
// See ./harness.ts for the scratch setup.
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runPi } from "../../src/runner/run-pi";
import {
  fauxRuntime,
  OIDC_AND_INPUT_VARS,
  readExecutionFile,
  useScratch,
} from "./harness";

const getScratch = useScratch();

async function writePrompt(text: string) {
  await Bun.write(getScratch().promptPath, text);
}

describe("runPi", () => {
  test("appends the expansion of a slash command in the user request", async () => {
    const seen: string[] = [];
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        for (const message of context.messages) {
          if (message.role !== "user") continue;
          const content = message.content;
          seen.push(
            typeof content === "string"
              ? content
              : content.map((p) => ("text" in p ? p.text : "")).join(""),
          );
        }
        return fauxAssistantMessage("Reviewed.");
      },
    ]);
    const { cwd, promptPath } = getScratch();
    await Bun.write(
      join(cwd, ".pi/skills/review-pr/SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nCheck the tests.\n",
    );
    await writePrompt(
      "<trigger_comment>@pi /skill:review-pr auth</trigger_comment>",
    );
    await Bun.write(
      join(dirname(promptPath), "user-request.txt"),
      "/skill:review-pr auth",
    );

    const result = await runPi(promptPath, { model, cwd, modelRuntime });

    expect(result.conclusion).toBe("success");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toStartWith(
      '<trigger_comment>@pi /skill:review-pr auth</trigger_comment>\n\n<skill name="review-pr"',
    );
    expect(seen[0]).toContain("Check the tests.\n</skill>\n\nauth");
  });

  test("sends the prompt unchanged when the request is not a known command", async () => {
    const seen: string[] = [];
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        const user = context.messages.find((m) => m.role === "user");
        const content = user?.content ?? "";
        seen.push(
          typeof content === "string"
            ? content
            : content.map((p) => ("text" in p ? p.text : "")).join(""),
        );
        return fauxAssistantMessage("Done.");
      },
    ]);
    const { cwd, promptPath } = getScratch();
    await writePrompt("Fix the bug.");
    await Bun.write(
      join(dirname(promptPath), "user-request.txt"),
      "/skill:missing",
    );

    await runPi(promptPath, { model, cwd, modelRuntime });

    expect(seen).toEqual(["Fix the bug."]);
  });

  test("runs the prompt and reports success, the session id and the execution file", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("All done."),
    ]);
    await writePrompt("Say you are done.");

    const result = await runPi(getScratch().promptPath, {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(result.conclusion).toBe("success");
    expect(result.sessionId).toBeString();
    expect(result.sessionId!.length).toBeGreaterThan(0);
    expect(result.executionFile).toBe(
      join(process.env.RUNNER_TEMP!, "pi-execution-output.json"),
    );

    const records = readExecutionFile(result.executionFile!);
    expect(records[0]).toMatchObject({
      type: "session",
      id: result.sessionId,
    });
    const assistantEnd = records.find(
      (r) => r.type === "message_end" && r.message.role === "assistant",
    );
    expect(assistantEnd?.message.content).toEqual([
      { type: "text", text: "All done." },
    ]);
    expect(assistantEnd?.message.usage.cost.total).toBeNumber();
    expect(records.some((r) => r.type === "agent_settled")).toBe(true);
    // Streaming deltas are left out; message_end carries the final message.
    expect(records.some((r) => r.type === "message_update")).toBe(false);
  });

  test("ends the execution file with the run's total token usage and cost", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Said hi."),
    ]);
    await writePrompt("Say hi with bash.");

    const result = await runPi(getScratch().promptPath, {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: "Bash",
    });

    const records = readExecutionFile(result.executionFile!);
    const responses = records
      .filter((r) => r.type === "message_end" && r.message.role === "assistant")
      .map((r) => r.message.usage);
    expect(responses).toHaveLength(2);
    const stats = records.at(-1)!;
    expect(stats.type).toBe("session_stats");
    expect(stats.sessionId).toBe(result.sessionId);
    expect(stats.assistantMessages).toBe(2);
    expect(stats.toolCalls).toBe(1);
    expect(stats.tokens.total).toBe(
      responses[0].totalTokens + responses[1].totalTokens,
    );
    expect(stats.tokens.total).toBeGreaterThan(0);
    expect(stats.cost).toBeCloseTo(
      responses[0].cost.total + responses[1].cost.total,
    );
    // Wall time of the session, shown in the tracking comment.
    expect(stats.durationMs).toBeNumber();
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("fails with the model's error and still writes the execution file", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "400 invalid request: unsupported parameter",
      }),
    ]);
    await writePrompt("Say you are done.");

    await expect(
      runPi(getScratch().promptPath, {
        model,
        cwd: getScratch().cwd,
        modelRuntime,
      }),
    ).rejects.toThrow("400 invalid request: unsupported parameter");

    const records = readExecutionFile(
      join(process.env.RUNNER_TEMP!, "pi-execution-output.json"),
    );
    const assistantEnd = records.find(
      (r) => r.type === "message_end" && r.message.role === "assistant",
    );
    expect(assistantEnd?.message.stopReason).toBe("error");
  });

  test("refuses to run without a model", async () => {
    const { faux, modelRuntime } = await fauxRuntime([
      fauxAssistantMessage("unused"),
    ]);
    await writePrompt("Say you are done.");

    for (const model of [undefined, "", "  "]) {
      await expect(
        runPi(getScratch().promptPath, {
          model,
          cwd: getScratch().cwd,
          modelRuntime,
        }),
      ).rejects.toThrow("The model input is required");
    }
    expect(faux.state.callCount).toBe(0);
  });

  test("refuses to run without a prompt", async () => {
    const { faux, model, modelRuntime } = await fauxRuntime([
      fauxAssistantMessage("unused"),
    ]);
    const { cwd, promptPath } = getScratch();
    const options = { model, cwd, modelRuntime };

    await expect(runPi(promptPath, options)).rejects.toThrow(
      `Prompt file '${promptPath}' does not exist.`,
    );
    await writePrompt("");
    await expect(runPi(promptPath, options)).rejects.toThrow(
      "Prompt file is empty",
    );
    expect(faux.state.callCount).toBe(0);
  });

  test("applies pi's own arguments from pi_args", async () => {
    let seen: { reasoning?: string; transcript: string } | undefined;
    const { modelRuntime, model } = await fauxRuntime([
      (context, options) => {
        seen = {
          reasoning: options?.reasoning,
          transcript: JSON.stringify(context.messages),
        };
        return fauxAssistantMessage("Done.");
      },
    ]);
    await writePrompt("Say you are done.");

    await runPi(getScratch().promptPath, {
      model,
      piArgs: `--thinking high
        # a comment line
        --append-system-prompt 'Answer like a pirate.'`,
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(seen?.reasoning).toBe("high");
    expect(seen?.transcript).toContain("Answer like a pirate.");
  });

  test("sends the api_key input to the model's provider", async () => {
    let apiKey: string | undefined;
    const { modelRuntime, model } = await fauxRuntime([
      (_context, options) => {
        apiKey = options?.apiKey;
        return fauxAssistantMessage("Done.");
      },
    ]);
    await writePrompt("Say you are done.");

    await runPi(getScratch().promptPath, {
      model,
      apiKey: "key-from-the-api-key-input",
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(apiKey).toBe("key-from-the-api-key-input");
  });

  test("reads the provider's key from its environment variable by default", async () => {
    let apiKey: string | undefined;
    const { modelRuntime, model } = await fauxRuntime([
      (_context, options) => {
        apiKey = options?.apiKey;
        return fauxAssistantMessage("Done.");
      },
    ]);
    await writePrompt("Say you are done.");

    await runPi(getScratch().promptPath, {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(apiKey).toBe("key-from-the-environment");
  });

  test("rejects pi_args the action does not support, before calling the model", async () => {
    const { faux, modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("unused"),
    ]);
    await writePrompt("Say you are done.");

    const cases: Array<[string, string]> = [
      ["--model other/model", "use the model input"],
      ["--api-key secret", "use the api_key input"],
      ["--session abc", "--session is not supported"],
      ["--no-such-flag", "--no-such-flag is not supported"],
      ["hello", "unexpected argument 'hello'"],
    ];
    for (const [piArgs, message] of cases) {
      await expect(
        runPi(getScratch().promptPath, {
          model,
          piArgs,
          cwd: getScratch().cwd,
          modelRuntime,
        }),
      ).rejects.toThrow(message);
    }
    expect(faux.state.callCount).toBe(0);
  });

  test("writes nothing under ~/.pi/agent", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("Done."),
    ]);
    await writePrompt("Say you are done.");

    await runPi(getScratch().promptPath, {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(existsSync(join(process.env.HOME!, ".pi"))).toBe(false);
  });

  test("keeps the OIDC token request variables and ALL_INPUTS out of the agent's environment", async () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.example/token";
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "oidc-request-token";
    process.env.ALL_INPUTS = '{"prompt":"x"}';
    const { modelRuntime, model } = await fauxRuntime([
      // Names only, so a failing assertion never prints this machine's secrets.
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "env | cut -d= -f1" }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("Listed the environment."),
    ]);
    await writePrompt("Print the environment.");

    const result = await runPi(getScratch().promptPath, {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: "Bash",
    });

    const bashEnd = readExecutionFile(result.executionFile!).find(
      (r) => r.type === "tool_execution_end" && r.toolName === "bash",
    );
    const output: string = bashEnd?.result.content[0].text;
    const names = output.split("\n");
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain("HOME");
    for (const name of OIDC_AND_INPUT_VARS) {
      expect(names).not.toContain(name);
    }
  });

  describe("show_full_output", () => {
    // A GitHub token by format, so redactSecrets() catches it.
    const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

    async function runLogged(showFullOutput?: boolean) {
      const { modelRuntime, model } = await fauxRuntime([
        fauxAssistantMessage(
          fauxToolCall("bash", { command: `echo ${TOKEN}` }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Printed it."),
      ]);
      await writePrompt("Print the token.");
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await runPi(getScratch().promptPath, {
          model,
          cwd: getScratch().cwd,
          modelRuntime,
          allowedTools: "Bash",
          showFullOutput,
        });
        return log.mock.calls.map((args) => args.join(" ")).join("\n");
      } finally {
        log.mockRestore();
      }
    }

    test("logs every recorded event, with secrets redacted", async () => {
      const output = await runLogged(true);
      expect(output).toContain('"type": "tool_execution_end"');
      expect(output).toContain("Printed it.");
      expect(output).toContain("echo [REDACTED_GITHUB_TOKEN]");
      expect(output).not.toContain(TOKEN);
      // Streaming deltas stay out of the log, as out of the execution file.
      expect(output).not.toContain('"type": "message_update"');
    });

    test("logs no events by default", async () => {
      const output = await runLogged();
      expect(output).not.toContain('"type": "tool_execution_end"');
      expect(output).not.toContain("Printed it.");
      expect(output).toContain("show_full_output");
    });
  });
});
