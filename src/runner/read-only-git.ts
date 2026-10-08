import { parse as parseShellWords } from "shell-quote";
import { findShellSyntax } from "./shell-syntax";

/**
 * git commands tag mode runs without a rule. Upstream's tag mode prompt tells
 * the model to run `git status` and `git diff`, which Claude Code allows as
 * read-only commands; pi has no such set (docs/upstream-divergence.md).
 */
const READ_ONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "show"]);

/**
 * Long options that make these commands write a file (`--output`) or run a
 * configured program (`--ext-diff`, `--textconv`). git also accepts any
 * unambiguous prefix of a long option, so `--outp=x` is `--output=x`.
 */
const UNSAFE_LONG_OPTIONS = ["output", "ext-diff", "textconv"];

function isUnsafeOption(word: string): boolean {
  if (!word.startsWith("--")) return false;
  const name = word.slice(2).split("=")[0]!;
  return (
    name.length > 0 &&
    UNSAFE_LONG_OPTIONS.some((option) => option.startsWith(name))
  );
}

/**
 * Whether a bash command is `git status`, `git diff`, `git log` or `git show`
 * with nothing that could write files or run other programs. The command must
 * be one simple command starting with `git` and the subcommand: no variable
 * assignments (GIT_EXTERNAL_DIFF=…), no global options (-c, -C, --git-dir),
 * which could point git at other config or another repository, and no
 * variables or globs.
 */
export function isReadOnlyGitCommand(command: string): boolean {
  // bash expands $NAME, which shell-quote reads as empty: `--$X=file` could
  // be --output. No read-only use needs a variable.
  if (command.includes("$") || findShellSyntax(command)) return false;
  const words = parseShellWords(command);
  if (!words.every((word) => typeof word === "string")) return false;
  const [program, subcommand, ...args] = words as string[];
  return (
    program === "git" &&
    subcommand !== undefined &&
    READ_ONLY_SUBCOMMANDS.has(subcommand) &&
    !args.some(isUnsafeOption)
  );
}
