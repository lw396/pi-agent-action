// Runner seam (issue #7): runPi() driven end to end by pi's faux provider.
// No real model is called, and nothing outside the scratch directory is
// touched: RUNNER_TEMP and HOME point into it for the duration of each test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runPi } from "../../src/runner/run-pi";

type Scratch = {
  root: string;
  cwd: string;
  promptPath: string;
  savedEnv: Record<string, string | undefined>;
};

const OIDC_AND_INPUT_VARS = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ALL_INPUTS",
];
const ENV_KEYS = [
  "RUNNER_TEMP",
  "HOME",
  "FAUX_TEST_API_KEY",
  ...OIDC_AND_INPUT_VARS,
];

let scratch: Scratch;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "run-pi-test-"));
  const savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.RUNNER_TEMP = join(root, "runner-temp");
  process.env.HOME = join(root, "home");
  process.env.FAUX_TEST_API_KEY = "key-from-the-environment";
  const cwd = join(root, "work");
  await Bun.write(join(cwd, ".keep"), "");
  await Bun.write(join(process.env.RUNNER_TEMP, ".keep"), "");
  const promptPath = join(root, "prompt.txt");
  scratch = { root, cwd, promptPath, savedEnv };
});

afterEach(() => {
  for (const [key, value] of Object.entries(scratch.savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch.root, { recursive: true, force: true });
});

/** A model runtime that only knows the faux provider, scripted with responses. */
async function fauxRuntime(responses: FauxResponseStep[]) {
  const faux = fauxProvider({
    models: [
      {
        id: "faux-model",
        reasoning: true,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  // The faux provider accepts any request; authenticate it by API key like a
  // real provider, so a test can see which key reaches the request.
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: { apiKey: envApiKeyAuth("Faux API key", ["FAUX_TEST_API_KEY"]) },
  });
  const model = faux.getModel();
  return { faux, modelRuntime, model: `${model.provider}/${model.id}` };
}

async function writePrompt(text: string) {
  await Bun.write(scratch.promptPath, text);
}

function readExecutionFile(path: string): Array<Record<string, any>> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("runPi", () => {
  test("runs the prompt and reports success, the session id and the execution file", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("All done."),
    ]);
    await writePrompt("Say you are done.");

    const result = await runPi(scratch.promptPath, {
      model,
      cwd: scratch.cwd,
      modelRuntime,
    });

    expect(result.conclusion).toBe("success");
    expect(result.sessionId).toBeString();
    expect(result.sessionId!.length).toBeGreaterThan(0);
    expect(result.executionFile).toBe(
      join(process.env.RUNNER_TEMP!, "claude-execution-output.json"),
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

    const result = await runPi(scratch.promptPath, {
      model,
      cwd: scratch.cwd,
      modelRuntime,
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
      runPi(scratch.promptPath, { model, cwd: scratch.cwd, modelRuntime }),
    ).rejects.toThrow("400 invalid request: unsupported parameter");

    const records = readExecutionFile(
      join(process.env.RUNNER_TEMP!, "claude-execution-output.json"),
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
        runPi(scratch.promptPath, { model, cwd: scratch.cwd, modelRuntime }),
      ).rejects.toThrow("The model input is required");
    }
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

    await runPi(scratch.promptPath, {
      model,
      piArgs: `--thinking high
        # a comment line
        --append-system-prompt 'Answer like a pirate.'`,
      cwd: scratch.cwd,
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

    await runPi(scratch.promptPath, {
      model,
      apiKey: "key-from-the-api-key-input",
      cwd: scratch.cwd,
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

    await runPi(scratch.promptPath, { model, cwd: scratch.cwd, modelRuntime });

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
        runPi(scratch.promptPath, {
          model,
          piArgs,
          cwd: scratch.cwd,
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

    await runPi(scratch.promptPath, {
      model,
      cwd: scratch.cwd,
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

    const result = await runPi(scratch.promptPath, {
      model,
      cwd: scratch.cwd,
      modelRuntime,
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
});
