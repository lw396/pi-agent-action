// The Runner expands slash commands from the trigger comment itself, because
// pi only expands them at the start of a prompt (src/runner/slash-command.ts).
// These tests pin that its output is exactly what pi produces, so a change in
// pi's expansion shows up when pi is upgraded.
import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expandSlashCommand } from "../../src/runner/slash-command";
import { createFauxSession, type FauxSession } from "./harness";

let current: FauxSession | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

const files = {
  ".pi/skills/review-pr/SKILL.md":
    "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n\nCheck the tests in ./checklist.md.\n",
  ".agents/skills/tdd/SKILL.md":
    "---\nname: tdd\ndescription: Test-driven development.\n---\n\n# TDD\n\nRed, then green.\n",
  ".pi/prompts/triage.md":
    "---\ndescription: Triage an issue\n---\nLabel issue $1 as ${2:-bug}. Notes: ${@:3}\n",
};

/** The text of the user message pi sent for this prompt. */
async function piExpansion(text: string): Promise<string> {
  current = await createFauxSession({
    responses: [fauxAssistantMessage("ok")],
    files,
    loadSkillsAndPrompts: true,
  });
  await current.session.prompt(text);
  const message = current.session.messages.find((m) => m.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((part) => ("text" in part ? part.text : ""))
    .join("");
}

describe("slash command expansion matches pi", () => {
  for (const command of [
    "/skill:review-pr",
    "/skill:review-pr focus on auth",
    "/skill:tdd",
    "/triage 42",
    '/triage 42 "needs info" check the logs',
  ]) {
    test(command, async () => {
      const fromPi = await piExpansion(command);
      expect(fromPi).not.toBe(command);
      expect(expandSlashCommand(command, current!.resourceLoader)).toBe(fromPi);
    });
  }
});
