// Issue #2, AC 4: the bash tool's spawnHook can rewrite env and command, and
// wrapping the command in bwrap stops it reading the pi process's environment
// through /proc and from escalating with sudo.
//
// The tool is built with createBashToolDefinition(), which takes the same
// options as createBashTool(): customTools needs a ToolDefinition, and
// createBashTool() returns an AgentTool.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  defineTool,
  type BashSpawnContext,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import {
  createFauxSession,
  lastToolResultText,
  type FauxSession,
} from "./harness";

const SECRET_NAME = "PI_TEST_SECRET";
const SECRET_VALUE = "test-secret-value-0123456789";
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "CI"];
// Variables bash itself exports to the commands it runs.
const SHELL_ADDED = ["PWD", "OLDPWD", "SHLVL", "_"];

// Prints only the names of the variables in the given environ files, never
// their values, so a failing test cannot leak the developer's secrets.
const environNames = (files: string) =>
  `cat ${files} 2>/dev/null | tr '\\0' '\\n' | cut -d= -f1 | sort -u | sed 's/^/name:/'`;

function namesIn(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("name:"))
    .map((line) => line.slice("name:".length))
    .filter(Boolean);
}

function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => ENV_ALLOWLIST.includes(name)),
  );
}

function bwrapCommand(command: string, cwd: string): string {
  return quote([
    "bwrap",
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
  ]);
}

function bwrapUsable(): boolean {
  if (process.platform !== "linux") return false;
  const probe = spawnSync(
    "bwrap",
    ["--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "true"],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

let current: FauxSession | undefined;

/** Runs one bash command through a session whose bash tool uses `hook`. */
async function runBash(
  command: string,
  hook: (context: BashSpawnContext) => BashSpawnContext,
): Promise<{ output: string; hookSaw: BashSpawnContext[] }> {
  const hookSaw: BashSpawnContext[] = [];
  let output = "";
  current = await createFauxSession({
    responses: [
      fauxAssistantMessage(fauxToolCall("bash", { command }), {
        stopReason: "toolUse",
      }),
      (context) => {
        output = lastToolResultText(context);
        return fauxAssistantMessage("done");
      },
    ],
    sessionOptions: {
      // A custom tool named "bash" replaces the built-in one. defineTool()
      // widens the typed definition so it fits the customTools array.
      customTools: [
        defineTool(
          createBashToolDefinition(process.cwd(), {
            spawnHook: (context) => {
              hookSaw.push(context);
              return hook(context);
            },
          }),
        ),
      ],
    },
  });
  await current.session.prompt("run it");
  return { output, hookSaw };
}

beforeEach(() => {
  process.env[SECRET_NAME] = SECRET_VALUE;
});
afterEach(() => {
  delete process.env[SECRET_NAME];
  current?.dispose();
  current = undefined;
});

describe("bash spawnHook", () => {
  test("replaces the built-in bash tool and receives the full process env", async () => {
    const { hookSaw } = await runBash("true", (context) => context);
    expect(hookSaw).toHaveLength(1);
    expect(hookSaw[0]!.env[SECRET_NAME]).toBe(SECRET_VALUE);
    // pi adds its session metadata before the hook runs.
    expect(Object.keys(hookSaw[0]!.env).some((k) => k.startsWith("PI_"))).toBe(
      true,
    );
  });

  test("rewrites env and command", async () => {
    const { output } = await runBash(
      "env | cut -d= -f1 | sed 's/^/name:/'",
      (context) => ({
        ...context,
        command: `echo hooked; ${context.command}`,
        env: filterEnv(context.env),
      }),
    );
    expect(output).toContain("hooked");
    const names = namesIn(output);
    expect(names).toContain("PATH");
    expect(names).not.toContain(SECRET_NAME);
    for (const name of names) {
      expect([...ENV_ALLOWLIST, ...SHELL_ADDED]).toContain(name);
    }
  });

  // Control for the bwrap test below: env filtering alone does not hide the
  // pi process's own environment, which /proc exposes. (/proc/<pid>/environ is
  // the environment at exec time, so it is checked by variable names that are
  // outside the allowlist rather than by SECRET_VALUE.)
  test.skipIf(process.platform !== "linux")(
    "without bwrap, a filtered env still leaks through /proc of the pi process",
    async () => {
      const { output } = await runBash(
        environNames(`/proc/${process.pid}/environ`),
        (context) => ({ ...context, env: filterEnv(context.env) }),
      );
      const leaked = namesIn(output).filter(
        (name) => !ENV_ALLOWLIST.includes(name),
      );
      expect(leaked.length).toBeGreaterThan(0);
    },
  );
});

// spawnHook only covers bash. The file tools run inside the pi process, so
// they can read /proc/self/environ unless something else blocks them.
test.skipIf(process.platform !== "linux")(
  "the read tool is not covered by spawnHook and can read the process env",
  async () => {
    let readResult = "";
    current = await createFauxSession({
      responses: [
        fauxAssistantMessage(
          fauxToolCall("read", { path: "/proc/self/environ" }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          readResult = lastToolResultText(context);
          return fauxAssistantMessage("done");
        },
      ],
    });
    await current.session.prompt("read it");
    // Checked by name only, so a failure does not print the values.
    expect(readResult.includes("PATH=")).toBe(true);
  },
);

describe.skipIf(!bwrapUsable())("bash spawnHook with bwrap", () => {
  const sandbox = (context: BashSpawnContext): BashSpawnContext => ({
    ...context,
    command: bwrapCommand(context.command, context.cwd),
    env: filterEnv(context.env),
  });

  test("cannot read the pi process's env through /proc", async () => {
    const { output } = await runBash(
      [
        "echo ppid=$PPID",
        `test -e /proc/${process.pid} && echo outer-visible || echo outer-hidden`,
        // Every environment visible inside the sandbox, including $PPID's.
        environNames("/proc/[0-9]*/environ"),
      ].join("; "),
      sandbox,
    );
    // bwrap's init is pid 1 of the new namespace and the command's parent.
    expect(output).toContain("ppid=1");
    expect(output).toContain("outer-hidden");
    const names = namesIn(output);
    expect(names).toContain("PATH");
    for (const name of names) {
      expect([...ENV_ALLOWLIST, ...SHELL_ADDED]).toContain(name);
    }
  });

  test("runs with no_new_privs, so sudo cannot run as root", async () => {
    const { output } = await runBash(
      "grep NoNewPrivs /proc/self/status; command -v sudo >/dev/null && sudo -n true; true",
      sandbox,
    );
    expect(output).toMatch(/NoNewPrivs:\s+1/);
    if (Bun.which("sudo")) {
      expect(output).toContain('"no new privileges" flag is set');
    }
  });
});
