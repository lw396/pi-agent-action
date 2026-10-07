import { parse as parseShellWords } from "shell-quote";
import {
  parseArgs,
  type Args,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

/** What the `pi_args` input changes in the Runner's session. */
export type PiArgs = {
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  tools?: string[];
  excludeTools?: string[];
  noTools?: CreateAgentSessionOptions["noTools"];
  /** Options for pi's DefaultResourceLoader. */
  resources: {
    systemPrompt?: string;
    appendSystemPrompt?: string[];
    noSkills?: boolean;
    noPromptTemplates?: boolean;
    noContextFiles?: boolean;
  };
};

// parseArgs() fields that are not flags.
const NON_FLAG_FIELDS = new Set<keyof Args>([
  "messages",
  "fileArgs",
  "unknownFlags",
  "diagnostics",
]);

// Flags with an action input of their own.
const REPLACED_BY_INPUT: Partial<Record<keyof Args, string>> = {
  model: "use the model input instead",
  provider: "use the model input in provider/id form instead",
  apiKey: "use the api_key input instead",
};

// Flags the Runner applies. Session, output-mode, interactive and resource
// path flags have no meaning, or no safe meaning, for an action run.
const SUPPORTED = new Set<keyof Args>([
  "thinking",
  "systemPrompt",
  "appendSystemPrompt",
  "tools",
  "excludeTools",
  "noTools",
  "noBuiltinTools",
  "noSkills",
  "noPromptTemplates",
  "noContextFiles",
]);

function flagName(field: string): string {
  return `--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Split pi_args like a shell would, without running anything. */
function splitWords(text: string): string[] {
  // Whole-line comments, as in Upstream's claude_args.
  const withoutComments = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  return parseShellWords(withoutComments).map((word) => {
    if (typeof word === "string") return word;
    // An unquoted pattern such as mcp__github__* comes back as a glob.
    if ("op" in word && word.op === "glob") return word.pattern;
    throw new Error(
      `pi_args: shell syntax is not supported (found ${JSON.stringify(word)}). Quote the value instead.`,
    );
  });
}

/**
 * Parse the pi_args input with pi's own argument parser, and keep the flags
 * that apply to an action run. Anything else is an error rather than ignored,
 * so a workflow never silently runs without the behaviour it asked for.
 */
export function parsePiArgs(text: string | undefined): PiArgs {
  const result: PiArgs = { resources: {} };
  if (!text?.trim()) return result;

  const args = parseArgs(splitWords(text));

  const problems = args.diagnostics.map((d) => d.message);
  for (const word of [...args.messages, ...args.fileArgs]) {
    problems.push(`unexpected argument '${word}'; pi_args takes only flags`);
  }
  for (const flag of args.unknownFlags.keys()) {
    problems.push(`--${flag} is not supported`);
  }
  for (const [field, value] of Object.entries(args)) {
    const key = field as keyof Args;
    if (NON_FLAG_FIELDS.has(key) || SUPPORTED.has(key) || value === undefined) {
      continue;
    }
    problems.push(
      `${flagName(field)}: ${REPLACED_BY_INPUT[key] ?? `${flagName(field)} is not supported by the action`}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`Invalid pi_args: ${problems.join("; ")}`);
  }

  result.thinkingLevel = args.thinking;
  result.tools = args.tools;
  result.excludeTools = args.excludeTools;
  if (args.noTools) result.noTools = "all";
  else if (args.noBuiltinTools) result.noTools = "builtin";
  result.resources = {
    systemPrompt: args.systemPrompt,
    appendSystemPrompt: args.appendSystemPrompt,
    noSkills: args.noSkills,
    noPromptTemplates: args.noPromptTemplates,
    noContextFiles: args.noContextFiles,
  };
  return result;
}
