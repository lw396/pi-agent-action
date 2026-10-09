import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

// The spaces pi's file tools turn into plain spaces (pi's utils/paths.ts).
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export type WorkspacePathCheck =
  | { inside: true }
  | { inside: false; reason: "outside" | "git" };

/**
 * Resolve a file tool's path argument the way pi's edit and write tools do:
 * unicode spaces become spaces, a leading `@` is dropped, `~` is the home
 * directory, and a file:// URL is a path. pi does not export this function.
 */
function resolveToolPath(path: string, cwd: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return resolve(cwd, normalized);
}

/**
 * The real path a write to `path` lands on: symlinks in the existing part of
 * the path are resolved, the rest is appended. Undefined for a dangling
 * symlink, whose target cannot be checked.
 */
function realTarget(path: string): string | undefined {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      try {
        lstatSync(current);
        return undefined; // exists, but does not resolve: a dangling symlink
      } catch {
        // Does not exist yet: check its parent.
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether a file tool's path is inside the workspace, the directory where tag
 * mode lets the agent edit files without a rule, as Claude Code's acceptEdits
 * permission mode does in Upstream. Symlinks are followed, so a link inside
 * the workspace cannot point a write outside it. No `.git` directory, nested
 * ones included, is part of the workspace: a hook written there would run
 * commands no bash rule allows.
 */
export function checkWorkspacePath(
  path: string,
  workspace: string,
): WorkspacePathCheck {
  const target = realTarget(resolveToolPath(path, workspace));
  const root = realTarget(resolve(workspace));
  if (target === undefined || root === undefined) {
    return { inside: false, reason: "outside" };
  }
  if (target === root || !isWithin(target, root)) {
    return { inside: false, reason: "outside" };
  }
  const parts = relative(root, target)
    .split(sep)
    .map((part) => part.toLowerCase());
  if (parts.includes(".git")) return { inside: false, reason: "git" };
  return { inside: true };
}

/**
 * Whether a file tool's path reaches /proc, where any process's environment
 * can be read, following symlinks. With `orAncestor`, a directory that
 * contains /proc (the root) counts too, for tools that search recursively.
 * A path whose target cannot be resolved counts, since it cannot be checked.
 */
export function reachesProc(
  path: string,
  cwd: string,
  orAncestor = false,
): boolean {
  const target = realTarget(resolveToolPath(path, cwd));
  if (target === undefined) return true;
  if (isWithin(target, "/proc")) return true;
  return orAncestor && isWithin("/proc", target);
}

/** Whether `path` is `dir` or inside it; both are absolute. */
function isWithin(path: string, dir: string): boolean {
  const relativePath = relative(dir, path);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}
