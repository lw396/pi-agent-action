import type { McpServers } from "./mcp-servers";
import type { RunnerOptions } from "./run-pi";
import { parseToolRules, type ToolRule } from "./tool-rules";

/**
 * The action inputs the Runner uses, read once from the env vars that
 * action.yml sets from them. Nothing else reads these variables.
 */
export type RunnerInputs = {
  /** The prompt file the mode writes. */
  promptFile: string;
  model?: string;
  apiKey?: string;
  piArgs?: string;
  /** The allowed_tools input, which also decides the action's MCP servers. */
  allowedTools: ToolRule[];
  disallowedTools: ToolRule[];
  jsonSchema?: string;
  /**
   * Untrusted input (allowed_non_write_users): keep secrets out of bash,
   * unless the workflow opts out with subprocess_isolation: false.
   */
  isolateBash: boolean;
  allowedBashEnv?: string;
  /** show_full_output, or a debug rerun, which shows everything as in Upstream. */
  showFullOutput: boolean;
};

/** What a mode adds to the run, besides the workflow's inputs. */
export type ModeRunSettings = {
  /** Rules the mode allows on top of the allowed_tools input. */
  allowedTools: string[];
  acceptEdits: boolean;
  readOnlyGit: boolean;
  /** The action's MCP servers the run needs. */
  mcpServers: McpServers;
};

/**
 * Read the Runner's inputs. Throws on a tool rule the action cannot enforce
 * as written, so the run fails before anything is prepared.
 */
export function readRunnerInputs(env: NodeJS.ProcessEnv): RunnerInputs {
  return {
    promptFile:
      env.INPUT_PROMPT_FILE || `${env.RUNNER_TEMP}/pi-prompts/prompt.txt`,
    model: env.MODEL,
    apiKey: env.API_KEY,
    piArgs: env.PI_ARGS,
    allowedTools: parseToolRules(env.INPUT_ALLOWED_TOOLS, "allowed_tools"),
    disallowedTools: parseToolRules(
      env.INPUT_DISALLOWED_TOOLS,
      "disallowed_tools",
    ),
    jsonSchema: env.JSON_SCHEMA,
    isolateBash:
      !!env.ALLOWED_NON_WRITE_USERS && env.SUBPROCESS_ISOLATION !== "false",
    allowedBashEnv: env.ALLOWED_BASH_ENV,
    // RUNNER_DEBUG is what core.isDebug() reads.
    showFullOutput:
      env.INPUT_SHOW_FULL_OUTPUT === "true" || env.RUNNER_DEBUG === "1",
  };
}

/** The Runner's options for a run of the mode with these inputs. */
export function runnerOptions(
  inputs: RunnerInputs,
  mode: ModeRunSettings,
): RunnerOptions {
  return {
    model: inputs.model,
    apiKey: inputs.apiKey,
    piArgs: inputs.piArgs,
    // The mode's own rules come first, then the workflow's allowed_tools.
    allowedTools: [
      ...parseToolRules(mode.allowedTools.join("\n"), "allowed_tools"),
      ...inputs.allowedTools,
    ],
    disallowedTools: inputs.disallowedTools,
    acceptEdits: mode.acceptEdits,
    readOnlyGit: mode.readOnlyGit,
    jsonSchema: inputs.jsonSchema,
    isolateBash: inputs.isolateBash,
    allowedBashEnv: inputs.allowedBashEnv,
    showFullOutput: inputs.showFullOutput,
    mcpServers: mode.mcpServers,
  };
}
