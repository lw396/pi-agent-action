import * as core from "@actions/core";
import { spawnSync } from "node:child_process";
import {
  createBashToolDefinition,
  defineTool,
  type BashSpawnContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { BASH_ENV_ALLOWLIST } from "./env-allowlist";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variable names in the allowed_bash_env input, separated by commas,
 * spaces or newlines.
 */
export function parseAllowedBashEnv(input: string | undefined): string[] {
  const names = (input ?? "").split(/[\s,]+/).filter(Boolean);
  for (const name of names) {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`allowed_bash_env: '${name}' is not a variable name`);
    }
  }
  return names;
}

function filterEnv(
  env: NodeJS.ProcessEnv,
  allowed: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => allowed.has(name)),
  );
}

/**
 * bwrap's arguments for running the command in a sandbox: a new PID
 * namespace and /proc, so the pi process and its environment are out of
 * sight, with no_new_privs (bwrap always sets it), so sudo cannot run as root.
 * The file system is read-only except the working directory and an empty
 * /tmp. The network is shared, so git and package managers keep working.
 */
function bwrapArgs(command: string, cwd: string): string[] {
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    cwd,
    cwd,
    "--chdir",
    cwd,
    "--",
    "/bin/bash",
    "-c",
    command,
  ];
}

/**
 * The absolute path of a bwrap that can create the sandbox, or why there is
 * none. Resolved once, so later commands cannot put another bwrap on PATH.
 * The probe uses the same arguments as the commands, so a sandbox that
 * cannot be set up here falls back with a warning instead of failing every
 * command.
 */
function findBwrap(
  bwrapPath: string | undefined,
  cwd: string,
): { path: string } | { reason: string } {
  if (process.platform !== "linux") {
    return { reason: `bwrap is not available on ${process.platform}` };
  }
  const path = Bun.which(bwrapPath ?? "bwrap");
  if (!path) return { reason: `${bwrapPath ?? "bwrap"} was not found` };
  const probe = spawnSync(path, bwrapArgs("true", cwd), {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (probe.status !== 0) {
    const detail = (probe.stderr || String(probe.error ?? "")).trim();
    return { reason: `bwrap cannot create a sandbox here: ${detail}` };
  }
  return { path };
}

export type BashIsolationOptions = {
  /** The allowed_bash_env input. */
  allowedEnv?: string;
  /** bwrap to use, a name on PATH or a path. Defaults to bwrap on PATH. */
  bwrapPath?: string;
};

/**
 * A bash tool for untrusted input (allowed_non_write_users): it replaces the
 * built-in one, and its commands get only the allowlisted environment and,
 * where bwrap works, run in a sandbox. Without bwrap the environment is still
 * filtered, but a command can read the pi process's environment through
 * /proc, so a warning says so.
 */
export function isolatedBashTool(
  cwd: string,
  options: BashIsolationOptions,
): ToolDefinition {
  const allowed = new Set([
    ...BASH_ENV_ALLOWLIST,
    ...parseAllowedBashEnv(options.allowedEnv),
  ]);
  const bwrap = findBwrap(options.bwrapPath, cwd);
  if ("reason" in bwrap) {
    core.warning(
      `bash runs without a sandbox: ${bwrap.reason}. Its environment is filtered, but commands can still read the environment of the pi process through /proc.`,
    );
  }

  const definition = createBashToolDefinition(cwd, {
    spawnHook: (context: BashSpawnContext) => ({
      ...context,
      command:
        "path" in bwrap
          ? quote([bwrap.path, ...bwrapArgs(context.command, context.cwd)])
          : context.command,
      env: filterEnv(context.env, allowed),
    }),
  });
  // Registering a custom tool activates it; this one takes the built-in
  // bash's place only where pi would activate that (not with
  // --no-builtin-tools, for example).
  return defineTool({ ...definition, defaultActive: false });
}
