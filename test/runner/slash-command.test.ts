import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptTemplate, Skill } from "@earendil-works/pi-coding-agent";
import {
  expandSlashCommand,
  parseCommandArgs,
  substituteArgs,
  type SlashCommandSources,
} from "../../src/runner/slash-command";

const dir = mkdtempSync(join(tmpdir(), "slash-command-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const skillPath = join(dir, "SKILL.md");
writeFileSync(
  skillPath,
  "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n\nCheck the tests.\n",
);

const sources: SlashCommandSources = {
  getSkills: () => ({
    skills: [
      {
        name: "review-pr",
        description: "Review a pull request.",
        filePath: skillPath,
        baseDir: dir,
      } as Skill,
    ],
  }),
  getPrompts: () => ({
    prompts: [
      { name: "triage", content: "Label issue $1 as ${2:-bug}." },
      { name: "plain", content: "Summarise the change." },
    ] as PromptTemplate[],
  }),
};

describe("expandSlashCommand", () => {
  test("expands a skill into pi's <skill> block, without the frontmatter", () => {
    expect(expandSlashCommand("/skill:review-pr", sources)).toBe(
      `<skill name="review-pr" location="${skillPath}">\nReferences are relative to ${dir}.\n\n# Review\n\nCheck the tests.\n</skill>`,
    );
  });

  test("puts the skill's arguments after the block", () => {
    expect(
      expandSlashCommand("/skill:review-pr focus on auth\n", sources),
    ).toEndWith("</skill>\n\nfocus on auth");
  });

  test("substitutes a template's arguments", () => {
    expect(expandSlashCommand("/triage 42", sources)).toBe(
      "Label issue 42 as bug.",
    );
    expect(expandSlashCommand('/triage 42 "needs info"', sources)).toBe(
      "Label issue 42 as needs info.",
    );
  });

  test("returns a template without placeholders as is", () => {
    expect(expandSlashCommand("/plain extra words", sources)).toBe(
      "Summarise the change.",
    );
  });

  test("leaves unknown commands and plain requests alone", () => {
    expect(expandSlashCommand("/skill:missing", sources)).toBeUndefined();
    expect(expandSlashCommand("/missing", sources)).toBeUndefined();
    expect(expandSlashCommand("fix the login bug", sources)).toBeUndefined();
  });
});

describe("parseCommandArgs", () => {
  test("splits on whitespace and keeps quoted strings together", () => {
    expect(parseCommandArgs(`a  "b c" 'd e' f`)).toEqual([
      "a",
      "b c",
      "d e",
      "f",
    ]);
  });
});

describe("substituteArgs", () => {
  test("supports $@, $ARGUMENTS, defaults and slices", () => {
    const args = ["one", "two", "three"];
    expect(substituteArgs("$@|$ARGUMENTS", args)).toBe(
      "one two three|one two three",
    );
    expect(substituteArgs("${4:-none} ${@:2} ${@:1:2}", args)).toBe(
      "none two three one two",
    );
    expect(substituteArgs("$3 $5.", args)).toBe("three .");
  });
});
