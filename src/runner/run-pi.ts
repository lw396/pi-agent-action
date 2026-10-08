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
import { parsePiArgs } from "./pi-args";
import { writeExecutionFile } from "./execution-file";
import { mcpServerExtensions, type McpServers } from "./mcp-servers";
import {
  parseToolPermissions,
  toolPermissionsExtension,
} from "./tool-permissions";

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
  const toolPermissions = {
    ...parseToolPermissions(options.allowedTools, options.disallowedTools),
    editableWorkspace: options.acceptEdits ? cwd : undefined,
  };

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
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      toolPermissionsExtension(toolPermissions),
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
    tools: piArgs.tools,
    excludeTools: piArgs.excludeTools,
    noTools: piArgs.noTools,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
  });

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
  return { conclusion: "success", executionFile, sessionId };
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
