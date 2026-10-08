// Bash subprocess isolation (issue #12): with allowed_non_write_users set, the
// bash tool gets an allowlisted environment and, where bwrap works, runs in a
// sandbox that hides the pi process. See ./harness.ts for the scratch setup.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { runPi, type RunnerOptions } from "../../src/runner/run-pi";
import { BASH_ENV_ALLOWLIST } from "../../src/runner/env-allowlist";
import { fauxRuntime, readExecutionFile, useScratch } from "./harness";

const getScratch = useScratch();

const SECRET_NAME = "PI_TEST_SECRET";
const PASSED_NAME = "PI_TEST_PASSED";
// Variables bash itself exports to the commands it runs.
const SHELL_ADDED = ["PWD", "OLDPWD", "SHLVL", "_"];

// Prints only the names of the variables in the given environ files, never
// their values, so a failing test cannot leak the developer's secrets.
const environNames = (files: string) =>
  `cat ${files} 2>/dev/null | tr '\\0' '\\n' | cut -d= -f1 | sort -u | sed 's/^/name:/'`;
const ENV_NAMES = "env | cut -d= -f1 | sed 's/^/name:/'";

function namesIn(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("name:"))
    .map((line) => line.slice("name:".length))
    .filter(Boolean);
}

function bwrapUsable(): boolean {
  if (process.platform !== "linux" || !Bun.which("bwrap")) return false;
  const probe = spawnSync(
    "bwrap",
    ["--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "true"],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

let warningSpy: ReturnType<typeof spyOn<typeof core, "warning">>;

beforeEach(() => {
  process.env[SECRET_NAME] = "test-secret-value-0123456789";
  process.env[PASSED_NAME] = "passed-value";
  warningSpy = spyOn(core, "warning").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env[SECRET_NAME];
  delete process.env[PASSED_NAME];
  warningSpy.mockRestore();
});

/** Runs one bash command through runPi and returns the tool's output. */
async function runBash(
  command: string,
  options: Partial<RunnerOptions> = {},
): Promise<string> {
  const { modelRuntime, model } = await fauxRuntime([
    fauxAssistantMessage(fauxToolCall("bash", { command }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  await Bun.write(getScratch().promptPath, "Run the command.");
  const result = await runPi(getScratch().promptPath, {
    model,
    cwd: getScratch().cwd,
    modelRuntime,
    allowedTools: "Bash",
    ...options,
  });
  const end = readExecutionFile(result.executionFile!).find(
    (r) => r.type === "tool_execution_end",
  );
  return end?.result.content
    .map((block: { text?: string }) => block.text ?? "")
    .join("");
}

const warnings = () => warningSpy.mock.calls.map((call) => String(call[0]));

describe("bash env allowlist", () => {
  test("passes bash only the allowlisted variables", async () => {
    const output = await runBash(ENV_NAMES, { isolateBash: true });
    const names = namesIn(output);
    expect(names).toContain("PATH");
    expect(names).not.toContain(SECRET_NAME);
    expect(names).not.toContain(PASSED_NAME);
    for (const name of names) {
      expect([...BASH_ENV_ALLOWLIST, ...SHELL_ADDED]).toContain(name);
    }
  });

  test("keeps the variables that let commands write to later steps out of the allowlist", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_ENV",
      "GITHUB_PATH",
      "GITHUB_OUTPUT",
      "GITHUB_STATE",
      "GITHUB_STEP_SUMMARY",
      "ACTIONS_RUNTIME_TOKEN",
    ]) {
      expect(BASH_ENV_ALLOWLIST).not.toContain(name);
    }
  });

  test("passes the variables named in allowed_bash_env", async () => {
    const output = await runBash(ENV_NAMES, {
      isolateBash: true,
      allowedBashEnv: `${PASSED_NAME}, UNSET_VARIABLE`,
    });
    const names = namesIn(output);
    expect(names).toContain(PASSED_NAME);
    expect(names).not.toContain(SECRET_NAME);
    expect(names).not.toContain("UNSET_VARIABLE");
  });

  test("rejects a name in allowed_bash_env that is not a variable name, before calling the model", async () => {
    const { faux, modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("unused"),
    ]);
    await Bun.write(getScratch().promptPath, "Run the command.");
    await expect(
      runPi(getScratch().promptPath, {
        model,
        cwd: getScratch().cwd,
        modelRuntime,
        isolateBash: true,
        allowedBashEnv: "GOOD_NAME GITHUB_*",
      }),
    ).rejects.toThrow("allowed_bash_env: 'GITHUB_*' is not a variable name");
    expect(faux.state.callCount).toBe(0);
  });

  test("leaves bash's environment alone when isolation is off", async () => {
    const output = await runBash(ENV_NAMES);
    expect(namesIn(output)).toContain(SECRET_NAME);
  });

  test("warns that allowed_bash_env has no effect when isolation is off", async () => {
    await runBash("true", { allowedBashEnv: PASSED_NAME });
    expect(warnings().some((w) => w.includes("allowed_bash_env"))).toBe(true);
  });

  test("still applies the tool rules to the isolated bash", async () => {
    const output = await runBash("echo should-not-run", {
      isolateBash: true,
      allowedTools: "Bash(git status:*)",
    });
    expect(output).not.toContain("should-not-run");
  });

  test("keeps bash inactive when pi_args turns off the built-in tools", async () => {
    let declared: string[] = [];
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        declared = getCurrentTools(context.messages).map((tool) => tool.name);
        return fauxAssistantMessage("Done.");
      },
    ]);
    await Bun.write(getScratch().promptPath, "Say done.");
    await runPi(getScratch().promptPath, {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      isolateBash: true,
      piArgs: "--no-builtin-tools",
    });
    expect(declared).not.toContain("bash");
  });
});

/** Runs one tool call through runPi and returns its result. */
async function runTool(
  name: string,
  args: Record<string, string>,
  options: Partial<RunnerOptions> = {},
): Promise<{ isError: boolean; text: string }> {
  const { modelRuntime, model } = await fauxRuntime([
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  await Bun.write(getScratch().promptPath, "Run the tool.");
  const result = await runPi(getScratch().promptPath, {
    model,
    cwd: getScratch().cwd,
    modelRuntime,
    ...options,
  });
  const end = readExecutionFile(result.executionFile!).find(
    (r) => r.type === "tool_execution_end",
  );
  return {
    isError: end?.isError,
    text: end?.result.content
      .map((block: { text?: string }) => block.text ?? "")
      .join(""),
  };
}

// The file tools run in the pi process, outside any sandbox, so with bash
// isolated they must not reach the environment through /proc either.
describe.skipIf(process.platform !== "linux")("file tools and /proc", () => {
  test("read cannot open /proc/self/environ", async () => {
    const result = await runTool(
      "read",
      { path: "/proc/self/environ" },
      { isolateBash: true },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("/proc");
    expect(result.text).not.toContain("PATH=");
  });

  test("read cannot reach /proc through a symlink in the working directory", async () => {
    symlinkSync("/proc/self", join(getScratch().cwd, "self"));
    const result = await runTool(
      "read",
      { path: "self/environ" },
      { isolateBash: true },
    );
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("PATH=");
  });

  test("grep cannot search /proc, or / which contains it", async () => {
    for (const path of ["/proc/self", "/"]) {
      const result = await runTool(
        "grep",
        { pattern: "PATH=", path },
        // grep is not one of pi's default tools.
        { isolateBash: true, piArgs: "--tools grep" },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("/proc");
    }
  });

  test("read still reads files in the working directory", async () => {
    await Bun.write(join(getScratch().cwd, "notes.txt"), "hello notes");
    const result = await runTool(
      "read",
      { path: "notes.txt" },
      { isolateBash: true },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("hello notes");
  });

  test("read can open /proc when isolation is off", async () => {
    const result = await runTool("read", { path: "/proc/self/status" });
    expect(result.isError).toBe(false);
  });
});

describe("without bwrap", () => {
  test("filters the env and warns that /proc still exposes the pi process", async () => {
    const output = await runBash(ENV_NAMES, {
      isolateBash: true,
      bwrapPath: join(getScratch().root, "no-such-bwrap"),
    });
    expect(namesIn(output)).not.toContain(SECRET_NAME);
    expect(
      warnings().some((w) => w.includes("bwrap") && w.includes("/proc")),
    ).toBe(true);
  });
});

describe.skipIf(!bwrapUsable())("with bwrap", () => {
  test("cannot read the pi process's env through /proc", async () => {
    const output = await runBash(
      [
        "echo ppid=$PPID",
        `test -e /proc/${process.pid} && echo outer-visible || echo outer-hidden`,
        // Every environment visible inside the sandbox, including $PPID's.
        environNames("/proc/[0-9]*/environ"),
      ].join("; "),
      { isolateBash: true },
    );
    // bwrap's init is pid 1 of the new namespace and the command's parent.
    expect(output).toContain("ppid=1");
    expect(output).toContain("outer-hidden");
    const names = namesIn(output);
    expect(names).toContain("PATH");
    for (const name of names) {
      expect([...BASH_ENV_ALLOWLIST, ...SHELL_ADDED]).toContain(name);
    }
    expect(warnings()).toEqual([]);
  });

  test("runs with no_new_privs, so sudo cannot run as root", async () => {
    const output = await runBash(
      "grep NoNewPrivs /proc/self/status; command -v sudo >/dev/null && sudo -n true; true",
      { isolateBash: true },
    );
    expect(output).toMatch(/NoNewPrivs:\s+1/);
    if (Bun.which("sudo")) {
      expect(output).toContain('"no new privileges" flag is set');
    }
  });

  test("can write to the working directory but not outside it", async () => {
    // The scratch root is under /tmp, which the sandbox replaces with an
    // empty tmpfs; the repository checkout is read-only.
    const underTmp = join(getScratch().root, "under-tmp.txt");
    const readOnly = join(process.cwd(), `.bwrap-write-test-${process.pid}`);
    const output = await runBash(
      [
        "echo hi > inside.txt && cat inside.txt",
        `echo x > ${underTmp}`,
        `echo x > ${readOnly} || echo read-only-refused`,
      ].join("; "),
      { isolateBash: true },
    );
    expect(output).toContain("read-only-refused");
    expect(await Bun.file(join(getScratch().cwd, "inside.txt")).text()).toBe(
      "hi\n",
    );
    expect(existsSync(underTmp)).toBe(false);
    expect(existsSync(readOnly)).toBe(false);
  });
});
