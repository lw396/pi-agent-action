import { execFileSync } from "child_process";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseShellWords } from "shell-quote";
import { stripCommentLines } from "./pi-args";

/**
 * The skills input: one `gh skill install` call per line, as
 * `OWNER/REPO <skill[@version]> [--pin REF] [--allow-hidden-dirs]` or
 * `OWNER/REPO --all`. The action installs them outside the checkout, so they
 * cannot be committed with the agent's changes, and passes the directory to
 * pi as an additional skill path.
 */

/** Arguments for `gh skill install`, without the ones the action sets. */
export type SkillInstall = string[];

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const FLAGS_WITH_VALUE = new Set(["--pin"]);
const FLAGS = new Set(["--all", "--allow-hidden-dirs"]);
/** Flags that decide where skills go, which the action sets itself. */
const PLACEMENT_FLAGS = new Set(["--dir", "--agent", "--scope"]);

function splitWords(line: string): string[] {
  return parseShellWords(line).map((word) => {
    if (typeof word === "string") return word;
    throw new Error(
      `skills: shell syntax is not supported in '${line}'. Quote the value instead.`,
    );
  });
}

function parseLine(line: string): SkillInstall {
  const [repository, ...rest] = splitWords(line);
  if (!repository || !REPOSITORY.test(repository)) {
    throw new Error(
      `skills: '${line}' must start with a repository in OWNER/REPO form.`,
    );
  }
  const args = [repository];
  let skill: string | undefined;
  let all = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    const flag = word.split("=", 1)[0]!;
    if (PLACEMENT_FLAGS.has(flag)) {
      throw new Error(
        `skills: ${flag} in '${line}' is not supported; the action decides where skills are installed.`,
      );
    }
    if (FLAGS_WITH_VALUE.has(flag)) {
      const value = word.includes("=")
        ? word.slice(flag.length + 1)
        : rest[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`skills: ${flag} in '${line}' needs a value.`);
      }
      args.push(flag, value);
    } else if (FLAGS.has(word)) {
      all ||= word === "--all";
      args.push(word);
    } else if (word.startsWith("-")) {
      throw new Error(`skills: ${word} in '${line}' is not supported.`);
    } else if (skill === undefined) {
      skill = word;
      args.push(word);
    } else {
      throw new Error(
        `skills: '${line}' names more than one skill; put each on its own line.`,
      );
    }
  }
  // Without either, gh only lists the repository's skills.
  if (skill === undefined && !all) {
    throw new Error(
      `skills: '${line}' names no skill. Add a skill name, or --all for every skill in the repository.`,
    );
  }
  return args;
}

/** Parse the skills input. Throws on a line the action would not install as written. */
export function parseSkills(text: string | undefined): SkillInstall[] {
  return stripCommentLines(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map(parseLine);
}

/** Runs `gh` with these arguments; tests replace it. */
export type RunGh = (args: string[]) => void;

const runGh: RunGh = (args) => {
  try {
    execFileSync("gh", args, { stdio: "inherit", env: process.env });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "The skills input needs the GitHub CLI (gh), which is not installed on this runner.",
      );
    }
    // Without the leading "skill install" and the trailing "--dir <dir>".
    throw new Error(
      `gh skill install ${args.slice(2, -2).join(" ")} failed; see its output above.`,
    );
  }
};

/**
 * Install the skills into a new directory under RUNNER_TEMP and return it,
 * or undefined when there is nothing to install. gh authenticates with
 * GH_TOKEN, which the action sets before this runs.
 */
export async function installSkills(
  installs: SkillInstall[],
  run: RunGh = runGh,
): Promise<string | undefined> {
  if (installs.length === 0) return undefined;
  const dir = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), "pi-skills-"),
  );
  for (const args of installs) {
    run(["skill", "install", ...args, "--dir", dir]);
  }
  return dir;
}
