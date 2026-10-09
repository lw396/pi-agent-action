// Runner seam (issue #10): the json_schema input, through runPi() and pi's
// faux provider.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { runPi } from "../../src/runner/run-pi";
import { fauxRuntime, readExecutionFile, useScratch } from "./harness";

const getScratch = useScratch();

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    count: { type: "number" },
  },
  required: ["verdict", "count"],
});

function submit(args: Record<string, string | number>) {
  return fauxAssistantMessage(fauxToolCall("submit_result", args), {
    stopReason: "toolUse",
  });
}

function declaredTools(context: TranscriptContext) {
  return getCurrentTools(context.messages);
}

function lastToolResult(context: TranscriptContext): string {
  const result = context.messages.findLast((m) => m.role === "toolResult");
  return JSON.stringify(result?.content ?? []);
}

async function run(
  responses: Parameters<typeof fauxRuntime>[0],
  extra: { jsonSchema?: string; piArgs?: string } = { jsonSchema: SCHEMA },
) {
  const { faux, modelRuntime, model } = await fauxRuntime(responses);
  const result = runPi("Review the change.", {
    model,
    cwd: getScratch().cwd,
    modelRuntime,
    ...extra,
  });
  return { faux, result };
}

describe("structured output", () => {
  test("returns the submitted result as structured_output", async () => {
    const { faux, result } = await run([submit({ verdict: "pass", count: 3 })]);

    const { structuredOutput, executionFile } = await result;
    expect(JSON.parse(structuredOutput!)).toEqual({
      verdict: "pass",
      count: 3,
    });
    // Submitting ends the run: no follow-up request after the tool result.
    expect(faux.state.callCount).toBe(1);
    const end = readExecutionFile(executionFile!).find(
      (r) => r.type === "tool_execution_end" && r.toolName === "submit_result",
    );
    expect(end?.isError).toBe(false);
    expect(end?.result.details).toEqual({ verdict: "pass", count: 3 });
  });

  test("declares submit_result with the schema and no allowed_tools rule", async () => {
    let tools: unknown;
    const { result } = await run([
      (context) => {
        tools = declaredTools(context);
        return submit({ verdict: "fail", count: 0 });
      },
    ]);

    await result;
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "submit_result",
        parameters: JSON.parse(SCHEMA),
      }),
    );
  });

  test("reminds the model, with only submit_result left, when it stops without submitting", async () => {
    const requests: TranscriptContext[] = [];
    const { result } = await run([
      fauxAssistantMessage("Looks good to me."),
      (context) => {
        requests.push(structuredClone(context));
        return submit({ verdict: "pass", count: 1 });
      },
    ]);

    const { structuredOutput } = await result;
    expect(JSON.parse(structuredOutput!)).toEqual({
      verdict: "pass",
      count: 1,
    });
    expect(declaredTools(requests[0]!).map((t) => t.name)).toEqual([
      "submit_result",
    ]);
    expect(JSON.stringify(requests[0]!.messages.at(-2))).toContain(
      "submit_result",
    );
  });

  test("fails after two unanswered reminders, and still writes the execution file", async () => {
    const { faux, result } = await run([
      fauxAssistantMessage("Done."),
      fauxAssistantMessage("Still done."),
      fauxAssistantMessage("Really done."),
    ]);

    await expect(result).rejects.toThrow(
      "the model did not call submit_result, which json_schema requires, after 2 reminders",
    );
    expect(faux.state.callCount).toBe(3);
    const records = readExecutionFile(
      join(process.env.RUNNER_TEMP!, "pi-execution-output.json"),
    );
    expect(records.at(-1)?.type).toBe("session_stats");
  });

  test("returns schema validation errors to the model so it can submit again", async () => {
    let validationError = "";
    const { result } = await run([
      submit({ verdict: "maybe" }),
      (context) => {
        validationError = lastToolResult(context);
        return submit({ verdict: "fail", count: 2 });
      },
    ]);

    const { structuredOutput } = await result;
    expect(validationError).toContain("Validation failed");
    expect(validationError).toContain("verdict");
    expect(validationError).toContain("count");
    expect(JSON.parse(structuredOutput!)).toEqual({
      verdict: "fail",
      count: 2,
    });
  });

  test.each(["--tools read", "--no-tools", "--no-builtin-tools"])(
    "keeps submit_result when pi_args has %s",
    async (piArgs) => {
      const { result } = await run([submit({ verdict: "pass", count: 5 })], {
        jsonSchema: SCHEMA,
        piArgs,
      });

      const { structuredOutput } = await result;
      expect(JSON.parse(structuredOutput!)).toEqual({
        verdict: "pass",
        count: 5,
      });
    },
  );

  test("refuses pi_args that exclude submit_result, before calling the model", async () => {
    const { faux, result } = await run([fauxAssistantMessage("unused")], {
      jsonSchema: SCHEMA,
      piArgs: "--exclude-tools submit_result",
    });

    await expect(result).rejects.toThrow(
      "pi_args leaves out the submit_result tool, which json_schema needs",
    );
    expect(faux.state.callCount).toBe(0);
  });

  test("has no submit_result and no structured_output without json_schema", async () => {
    let tools: string[] = [];
    const { result } = await run(
      [
        (context) => {
          tools = declaredTools(context).map((t) => t.name);
          return fauxAssistantMessage("Done.");
        },
      ],
      {},
    );

    expect((await result).structuredOutput).toBeUndefined();
    expect(tools).not.toContain("submit_result");
  });

  test("rejects a json_schema that is not an object schema, before calling the model", async () => {
    const cases: Array<[string, string]> = [
      ["{not json", "The json_schema input is not valid JSON"],
      ['{"type":"array"}', "The json_schema input must describe an object"],
      ["[1]", "The json_schema input must describe an object"],
    ];
    for (const [jsonSchema, message] of cases) {
      const { faux, result } = await run([fauxAssistantMessage("unused")], {
        jsonSchema,
      });
      await expect(result).rejects.toThrow(message);
      expect(faux.state.callCount).toBe(0);
    }
  });
});
