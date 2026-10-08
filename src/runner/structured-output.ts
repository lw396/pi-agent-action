import { Type } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** The tool the model calls with its result when json_schema is set. */
export const SUBMIT_RESULT_TOOL = "submit_result";

/** Reminders sent when the model stops without submitting, before failing. */
export const MAX_REMINDERS = 2;

const REMINDER = `You have not submitted your result. Call ${SUBMIT_RESULT_TOOL} now, with your final result as its arguments. The run fails if you do not.`;

/** What the extension records during the run, read by the Runner afterwards. */
export type StructuredOutputState = {
  /** The arguments of the latest valid submit_result call. */
  result?: Record<string, unknown>;
  reminders: number;
};

/**
 * Parse the json_schema input: a JSON Schema for an object, which becomes
 * submit_result's parameters. Providers only accept object parameters, and
 * upstream's structured_output is an object of named fields, so other schemas
 * are refused before the model starts.
 */
export function parseJsonSchema(
  input: string | undefined,
): Record<string, unknown> | undefined {
  if (!input?.trim()) return undefined;
  let schema: unknown;
  try {
    schema = JSON.parse(input);
  } catch (error) {
    throw new Error(
      `The json_schema input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== "object"
  ) {
    throw new Error(
      'The json_schema input must describe an object: a JSON Schema with "type": "object" and the fields in "properties".',
    );
  }
  return schema as Record<string, unknown>;
}

/**
 * The structured output extension: registers submit_result with the
 * json_schema input as its parameters. pi validates each call against the
 * schema and returns any errors to the model, which can then call again.
 *
 * If the model stops without submitting, it is reminded, with every other
 * tool removed, up to MAX_REMINDERS times. The Runner fails the run when there
 * is still no result.
 */
export function structuredOutputExtension(
  schema: Record<string, unknown>,
  state: StructuredOutputState,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: SUBMIT_RESULT_TOOL,
      label: "Submit result",
      description:
        "Submit the final result of the task. Its arguments are the result. Call it once, when the task is done; the run ends after it.",
      promptSnippet: "Submit the final result of the task",
      promptGuidelines: [
        `When the task is done, call ${SUBMIT_RESULT_TOOL} with the final result. The run fails without it.`,
      ],
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      async execute(_toolCallId, params) {
        state.result = params;
        return {
          content: [{ type: "text", text: "Result submitted." }],
          details: params,
          terminate: true,
        };
      },
    });

    pi.on("agent_before_settle", (event) => {
      if (event.outcome !== "completed") return;
      if (state.result !== undefined || state.reminders >= MAX_REMINDERS) {
        return;
      }
      state.reminders++;
      pi.setActiveTools([SUBMIT_RESULT_TOOL]);
      return {
        continue: true,
        entries: [
          {
            type: "custom_message",
            customType: "structured-output-reminder",
            content: REMINDER,
            display: true,
          },
        ],
      };
    });
  };
}
