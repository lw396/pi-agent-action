import { readFileSync } from "fs";
import {
  stripFrontmatter,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-coding-agent";

/**
 * Written next to the prompt file by tag mode: the trigger comment's request
 * without the trigger phrase, e.g. "/skill:review-pr focus on auth".
 */
export const USER_REQUEST_FILENAME = "user-request.txt";

/** The skills and prompt templates pi loaded for the session. */
export type SlashCommandSources = {
  getSkills(): { skills: Skill[] };
  getPrompts(): { prompts: PromptTemplate[] };
};

/**
 * Expand a slash command from the trigger comment, as pi does when a prompt
 * starts with one: `/skill:<name> [args]` becomes the skill's file in a
 * <skill> block, `/<template> [args]` becomes the prompt template with its
 * arguments substituted. Returns undefined for anything else, including an
 * unknown name, so the request stays as the model reads it in the prompt.
 *
 * pi only expands text at the very start of a prompt, and the Runner's prompt
 * starts with the GitHub context, so the Runner expands the command itself
 * and appends the result. Upstream does the same by sending the command to
 * Claude Code as a second content block. The output matches pi's own
 * expansion; test/pi-sdk/slash-command.test.ts checks that against pi.
 */
export function expandSlashCommand(
  request: string,
  sources: SlashCommandSources,
): string | undefined {
  const text = request.trim();
  if (text.startsWith("/skill:")) return expandSkill(text, sources);
  if (text.startsWith("/")) return expandTemplate(text, sources);
  return undefined;
}

/** Mirrors AgentSession._expandSkillCommand in pi. */
function expandSkill(
  text: string,
  sources: SlashCommandSources,
): string | undefined {
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  const skill = sources.getSkills().skills.find((s) => s.name === name);
  if (!skill) return undefined;

  let body: string;
  try {
    body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
  } catch {
    return undefined;
  }
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

/** Mirrors expandPromptTemplate in pi's core/prompt-templates.js. */
function expandTemplate(
  text: string,
  sources: SlashCommandSources,
): string | undefined {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const template = sources
    .getPrompts()
    .prompts.find((t) => t.name === match[1]);
  if (!template) return undefined;
  return substituteArgs(template.content, parseCommandArgs(match[2] ?? ""));
}

/** Splits arguments on whitespace, keeping quoted strings together. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Substitutes $1, $@, $ARGUMENTS, ${N:-default}, ${@:-default} and
 * ${@:start[:length]} in a template, as pi does.
 */
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      defaultTarget?: string,
      defaultValue?: string,
      sliceStart?: string,
      sliceLength?: string,
      simple?: string,
    ) => {
      if (defaultTarget) {
        const value =
          defaultTarget === "@" || defaultTarget === "ARGUMENTS"
            ? allArgs
            : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : (defaultValue ?? "");
      }
      if (sliceStart) {
        const start = Math.max(parseInt(sliceStart, 10) - 1, 0);
        return sliceLength
          ? args.slice(start, start + parseInt(sliceLength, 10)).join(" ")
          : args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      return args[parseInt(simple ?? "", 10) - 1] ?? "";
    },
  );
}
