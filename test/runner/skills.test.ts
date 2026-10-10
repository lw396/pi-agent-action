// The skills input: parsed into `gh skill install` calls, installed into a
// directory outside the checkout, and loaded by the Runner from there.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runPi } from "../../src/runner/run-pi";
import { installSkills, parseSkills } from "../../src/runner/skills";
import { fauxRuntime, useScratch } from "./harness";

const getScratch = useScratch();

describe("parseSkills", () => {
  test("turns each line into gh skill install arguments", () => {
    expect(
      parseSkills(
        [
          "# comments and blank lines are skipped",
          "",
          "github/awesome-copilot git-commit@v1.2.0",
          "  monalisa/skills skills/monalisa/code-review --pin 3f2a9c1  ",
          "owner/repo --all --allow-hidden-dirs",
          "owner/repo review --pin=v2",
        ].join("\n"),
      ),
    ).toEqual([
      ["github/awesome-copilot", "git-commit@v1.2.0"],
      ["monalisa/skills", "skills/monalisa/code-review", "--pin", "3f2a9c1"],
      ["owner/repo", "--all", "--allow-hidden-dirs"],
      ["owner/repo", "review", "--pin", "v2"],
    ]);
  });

  test("is empty without the input", () => {
    expect(parseSkills(undefined)).toEqual([]);
    expect(parseSkills("  \n")).toEqual([]);
  });

  test.each([
    ["git-commit", "must start with a repository in OWNER/REPO form"],
    ["https://github.com/o/r git-commit", "OWNER/REPO form"],
    ["owner/repo", "names no skill"],
    ["owner/repo --pin v1", "names no skill"],
    ["owner/repo a b", "names more than one skill"],
    ["owner/repo a --pin", "--pin in 'owner/repo a --pin' needs a value"],
    [
      "owner/repo a --dir /tmp/x",
      "the action decides where skills are installed",
    ],
    ["owner/repo a --agent=claude-code", "the action decides where"],
    ["owner/repo a --scope user", "the action decides where"],
    [
      "owner/repo a --force",
      "--force in 'owner/repo a --force' is not supported",
    ],
    ["owner/repo a --from-local", "is not supported"],
    ["owner/repo a && rm -rf /", "shell syntax is not supported"],
  ])("rejects %p", (line, message) => {
    expect(() => parseSkills(line)).toThrow(message);
  });
});

describe("installSkills", () => {
  test("installs every line into one new directory under RUNNER_TEMP", async () => {
    const calls: string[][] = [];
    const dir = await installSkills(
      [
        ["github/awesome-copilot", "git-commit@v1.2.0"],
        ["owner/repo", "--all"],
      ],
      (args) => calls.push(args),
    );

    expect(dir).toStartWith(join(process.env.RUNNER_TEMP!, "pi-skills-"));
    expect(calls).toEqual([
      [
        "skill",
        "install",
        "github/awesome-copilot",
        "git-commit@v1.2.0",
        "--dir",
        dir!,
      ],
      ["skill", "install", "owner/repo", "--all", "--dir", dir!],
    ]);
  });

  test("does nothing without skills", async () => {
    const dir = await installSkills([], () => {
      throw new Error("gh should not run");
    });
    expect(dir).toBeUndefined();
  });
});

describe("the Runner", () => {
  /** The first user message pi sends for a request of `/skill:<name>`. */
  async function sentFor(name: string, piArgs?: string, skillsDir?: string) {
    let sent = "";
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        const user = context.messages.find((m) => m.role === "user");
        const content = user?.content ?? "";
        sent =
          typeof content === "string"
            ? content
            : content.map((p) => ("text" in p ? p.text : "")).join("");
        return fauxAssistantMessage("Done.");
      },
    ]);
    await runPi("Go.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      userRequest: `/skill:${name}`,
      piArgs,
      skillsDir,
    });
    return sent;
  }

  async function writeSkill(dir: string, name: string) {
    await Bun.write(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nFollow ${name}.\n`,
    );
  }

  test("loads the installed skills, even with --no-skills in pi_args", async () => {
    const skillsDir = join(getScratch().root, "installed");
    await writeSkill(skillsDir, "git-commit");
    await writeSkill(join(getScratch().cwd, ".pi/skills"), "repo-skill");

    expect(await sentFor("git-commit", undefined, skillsDir)).toContain(
      "Follow git-commit.",
    );
    expect(await sentFor("git-commit", "--no-skills", skillsDir)).toContain(
      "Follow git-commit.",
    );
    // --no-skills still drops the repository's own skills.
    expect(await sentFor("repo-skill", "--no-skills", skillsDir)).toBe("Go.");
  });
});
