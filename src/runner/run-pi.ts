import * as core from "@actions/core";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { setupPiSettings } from "./setup-pi-settings";
import { isolatedBashTool } from "./bash-isolation";
import { parsePiArgs } from "./pi-args";
import { writeExecutionFile } from "./execution-file";
import { mcpServerExtensions, type McpServers } from "./mcp-servers";
import {
  parseToolPermissions,
  toolPermissionsExtension,
} from "./tool-permissions";
import {
  parseJsonSchema,
  structuredOutputExtension,
  SUBMIT_RESULT_TOOL,
  type StructuredOutputState,
} from "./structured-output";

export type RunnerOptions = {
  /** Model in pi's `provider/id[:thinking]` form. Required. */
  model?: string;
  /**
   * The api_key input: a key for the model's provider, used instead of the
   * provider's environment variable. Like pi's --api-key, it is not stored.
   */
  apiKey?: string;
  /** The pi_args input: pi's own command-line flags, a supported subset. */
  piArgs?: string;
  /**
   * The allowed_tools input: rules in Claude Code's `Tool` / `Tool(pattern)`
   * syntax. Calls to tools other than the read-only ones must match a rule.
   */
  allowedTools?: string;
  /** The disallowed_tools input: rules that block calls, before allowed_tools. */
  disallowedTools?: string;
  /**
   * Let edit and write change files in the working directory without a rule,
   * like Claude Code's acceptEdits permission mode in Upstream's tag mode.
   */
  acceptEdits?: boolean;
  /**
   * Let bash run `git status`, `git diff`, `git log` and `git show` without a
   * rule, like Claude Code's read-only commands in Upstream's tag mode.
   */
  readOnlyGit?: boolean;
  /**
   * The json_schema input: a JSON Schema for an object. When set, the model
   * submits its result with the submit_result tool, and the run fails if it
   * does not.
   */
  jsonSchema?: string;
  /**
   * Isolate the bash tool, for untrusted input (allowed_non_write_users): its
   * commands get only allowlisted variables and run in bwrap where it works.
   */
  isolateBash?: boolean;
  /** The allowed_bash_env input: more variables the isolated bash keeps. */
  allowedBashEnv?: string;
  /**
   * bwrap for the isolated bash. Defaults to bwrap on PATH; tests point it at
   * a missing file to exercise the fallback.
   */
  bwrapPath?: string;
  /** The action's MCP servers, registered with `direct` exposure. */
  mcpServers?: McpServers;
  /** Working directory of the session. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Model runtime to use. Defaults to one that reads provider keys from the
   * environment and keeps every credential in memory. Tests pass a runtime
   * with pi's faux provider registered.
   */
  modelRuntime?: ModelRuntime;
};

export type RunnerResult = {
  conclusion: "success" | "failure";
  executionFile?: string;
  sessionId?: string;
  structuredOutput?: string;
};

// Streaming deltas: message_end and tool_execution_end carry the final values.
const OMITTED_EVENTS = new Set<AgentSessionEvent["type"]>([
  "message_update",
  "tool_execution_update",
]);

/**
 * Variables the agent must not see, removed as Upstream removes them from the
 * Claude Code environment. With the OIDC request pair the agent could mint new
 * tokens; ALL_INPUTS holds the serialized workflow inputs and is only needed
 * to detect which inputs were set, before the Runner starts.
 *
 * pi runs in this process (ADR-0001), so its tools and MCP servers inherit
 * process.env: the variables are deleted from it, not just from a child env.
 */
const AGENT_HIDDEN_ENV = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ALL_INPUTS",
];

async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), // never reads or writes auth.json
    modelsPath: null, // no models.json
    refreshOnCreate: false, // static catalog only, no network at startup
  });
}

/**
 * Run one pi session on the prompt in promptPath, in this process (ADR-0001).
 *
 * The Execution file is written whether the session succeeds or fails. A
 * failed session throws after the file is written, like Upstream's executor.
 */
export async function runPi(
  promptPath: string,
  options: RunnerOptions,
): Promise<RunnerResult> {
  const modelReference = options.model?.trim();
  if (!modelReference) {
    // pi would otherwise pick a model on its own; CI must not depend on that.
    throw new Error(
      "The model input is required. Set it to a pi model in provider/id form, for example opencode/gpt-6-luna.",
    );
  }

  const piArgs = parsePiArgs(options.piArgs);
  const cwd = options.cwd ?? process.cwd();
  const jsonSchema = parseJsonSchema(options.jsonSchema);
  const permissions = parseToolPermissions(
    options.allowedTools,
    options.disallowedTools,
  );
  if (jsonSchema) {
    // Submitting the result needs no rule; disallowed_tools can still block it.
    permissions.allowed.push({ text: "json_schema", tool: SUBMIT_RESULT_TOOL });
  }
  const toolPermissions = {
    ...permissions,
    editableWorkspace: options.acceptEdits ? cwd : undefined,
    readOnlyGit: options.readOnlyGit,
    procHiddenFrom: options.isolateBash ? cwd : undefined,
  };

  const customTools = options.isolateBash
    ? [
        isolatedBashTool(cwd, {
          allowedEnv: options.allowedBashEnv,
          bwrapPath: options.bwrapPath,
        }),
      ]
    : [];
  if (!options.isolateBash && options.allowedBashEnv?.trim()) {
    core.warning(
      "allowed_bash_env has no effect: bash is only isolated when allowed_non_write_users is set and subprocess_isolation is not false.",
    );
  }

  for (const name of AGENT_HIDDEN_ENV) {
    delete process.env[name];
  }

  const prompt = await readFile(promptPath, "utf-8");
  const modelRuntime = options.modelRuntime ?? (await createModelRuntime());

  const resolved = resolveCliModel({
    cliModel: modelReference,
    modelRuntime,
  });
  if (!resolved.model) {
    throw new Error(`Cannot use model '${modelReference}': ${resolved.error}`);
  }
  if (options.apiKey) {
    await modelRuntime.setRuntimeApiKey(
      resolved.model.provider,
      options.apiKey,
    );
  }

  // pi's global directory. Settings live in memory and sessions are not
  // persisted, so this stays empty; it only keeps pi away from ~/.pi/agent.
  const agentDir = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), "pi-agent-"),
  );
  const settingsManager = setupPiSettings();
  const structuredOutput: StructuredOutputState = { reminders: 0 };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      toolPermissionsExtension(toolPermissions),
      ...(jsonSchema
        ? [structuredOutputExtension(jsonSchema, structuredOutput)]
        : []),
      ...mcpServerExtensions(
        options.mcpServers ?? {},
        join(agentDir, "mcp.log"),
      ),
    ],
    ...piArgs.resources,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: resolved.model,
    // --thinking wins over a :<thinking> suffix on the model, as in pi's CLI.
    thinkingLevel: piArgs.thinkingLevel ?? resolved.thinkingLevel,
    tools: withSubmitResult(piArgs, jsonSchema !== undefined),
    excludeTools: piArgs.excludeTools,
    noTools: piArgs.noTools,
    customTools,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  if (
    jsonSchema &&
    !session.getActiveToolNames().includes(SUBMIT_RESULT_TOOL)
  ) {
    session.dispose();
    throw new Error(
      `pi_args leaves out the ${SUBMIT_RESULT_TOOL} tool, which json_schema needs. Remove it from --exclude-tools.`,
    );
  }

  const records: unknown[] = [sessionManager.getHeader()];
  session.subscribe((event) => {
    if (!OMITTED_EVENTS.has(event.type)) records.push(event);
  });

  let failure: string | undefined;
  let stats;
  const startedAt = Date.now();
  try {
    await session.bindExtensions({});
    await session.prompt(prompt);
    failure = sessionFailure(session.messages);
    if (
      failure === undefined &&
      jsonSchema &&
      structuredOutput.result === undefined
    ) {
      failure = `the model did not call ${SUBMIT_RESULT_TOOL}, which json_schema requires, after ${structuredOutput.reminders} reminders`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    // Totals for the whole run, so spend can be tracked per run.
    const {
      sessionFile: _file,
      contextUsage: _context,
      ...totals
    } = session.getSessionStats();
    stats = totals;
    session.dispose();
  }
  const durationMs = Date.now() - startedAt;
  records.push({ type: "session_stats", ...stats, durationMs });
  console.log(
    `pi used ${stats.tokens.total} tokens in ${stats.assistantMessages} responses, cost $${stats.cost.toFixed(4)}`,
  );

  const executionFile = await writeExecutionFile(records);
  const sessionId = session.sessionId;
  core.info(`Set session_id: ${sessionId}`);

  if (failure !== undefined) {
    throw new Error(`pi execution failed: ${failure}`);
  }
  return {
    conclusion: "success",
    executionFile,
    sessionId,
    structuredOutput:
      structuredOutput.result !== undefined
        ? JSON.stringify(structuredOutput.result)
        : undefined,
  };
}

/**
 * The tools list for the session. A --tools list or --no-tools from pi_args
 * would leave out submit_result, which json_schema needs: pi activates only
 * the tools a list names, and `tools` wins over `noTools`.
 */
function withSubmitResult(
  piArgs: ReturnType<typeof parsePiArgs>,
  needsSubmitResult: boolean,
): string[] | undefined {
  if (!needsSubmitResult) return piArgs.tools;
  if (piArgs.tools) return [...piArgs.tools, SUBMIT_RESULT_TOOL];
  if (piArgs.noTools === "all") return [SUBMIT_RESULT_TOOL];
  return undefined;
}

/**
 * Why the session failed, or undefined if it succeeded. pi reports a provider
 * error, after its own retries, as the stop reason of the final assistant
 * message rather than by rejecting prompt().
 */
function sessionFailure(
  messages: AgentSession["messages"],
): string | undefined {
  const last = messages.findLast((m) => m.role === "assistant");
  if (!last) return "the model did not respond";
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    return last.errorMessage ?? `the model stopped with ${last.stopReason}`;
  }
  return undefined;
}
