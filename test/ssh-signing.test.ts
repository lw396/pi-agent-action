// SSH commit signing against the real setup/cleanup functions. The key path is
// derived from homedir() at import time, so every case runs
// test/fixtures/ssh-signing-probe.ts in its own Bun process with an isolated
// HOME and a throwaway git repository as cwd. setupSshSigning only validates
// the key delimiters and writes the file, so a dummy key is enough; ssh-keygen
// never runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "fixtures", "ssh-signing-probe.ts");

const DUMMY_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\ndummy-key-material\n-----END OPENSSH PRIVATE KEY-----";

// git exports these into hooks; inherited they would point git at the
// enclosing repository instead of the temp repo, or make the probe read a
// config it did not write.
const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
] as const;

let root: string;
let homeDir: string;
let repoDir: string;
let keyPath: string;

// Every git command and the probe run with the same isolated HOME and without
// the inherited GIT_* overrides.
function isolatedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: homeDir,
  };
  for (const name of GIT_ENV_OVERRIDES) delete env[name];
  return env;
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: isolatedEnv(),
  }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ssh-signing-test-"));
  homeDir = join(root, "home");
  repoDir = join(root, "repo");
  keyPath = join(homeDir, ".ssh", "pi_signing_key");
  mkdirSync(homeDir);
  git(["init", "-q", repoDir], root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type ProbeResult = { ok: true } | { ok: false; message: string };

function probe(action: "setup" | "cleanup", key?: string): ProbeResult {
  const result = Bun.spawnSync({
    // The same runtime that runs the suite, including a custom Bun executable.
    cmd: [process.execPath, "run", PROBE, action, key ?? ""],
    cwd: repoDir,
    env: isolatedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const lastLine = result.stdout.toString().trim().split("\n").at(-1);
  if (!lastLine) {
    throw new Error(`probe produced no output: ${result.stderr.toString()}`);
  }
  const parsed = JSON.parse(lastLine) as ProbeResult;
  expect(result.exitCode).toBe(parsed.ok ? 0 : 1);
  return parsed;
}

function gitConfig(key: string): string {
  return git(["config", "--local", "--get", key], repoDir);
}

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
}

// Windows has no POSIX permission bits; the mode assertions only describe
// runners where `writeFile({ mode })` is enforced.
const modesEnforced = process.platform !== "win32";

describe("setupSshSigning", () => {
  test("writes the normalized key with private permissions", () => {
    expect(probe("setup", DUMMY_KEY)).toEqual({ ok: true });

    expect(readFileSync(keyPath, "utf8")).toBe(DUMMY_KEY + "\n");
    if (modesEnforced) {
      expect(permissions(keyPath)).toBe(0o600);
      expect(permissions(join(homeDir, ".ssh"))).toBe(0o700);
    }
  });

  test("keeps a single trailing newline when the key already has one", () => {
    expect(probe("setup", DUMMY_KEY + "\n")).toEqual({ ok: true });

    expect(readFileSync(keyPath, "utf8")).toBe(DUMMY_KEY + "\n");
  });

  test("configures git to sign commits with that key", () => {
    probe("setup", DUMMY_KEY);

    expect(gitConfig("gpg.format")).toBe("ssh");
    expect(gitConfig("user.signingkey")).toBe(keyPath);
    expect(gitConfig("commit.gpgsign")).toBe("true");
  });

  test.each([
    ["an empty key", "", "SSH signing key cannot be empty"],
    ["a whitespace-only key", " \n\t ", "SSH signing key cannot be empty"],
    ["a non-key string", "not a valid key", "Invalid SSH private key format"],
  ])("rejects %s without writing a key", (_label, key, message) => {
    expect(probe("setup", key)).toEqual({ ok: false, message });

    expect(existsSync(keyPath)).toBe(false);
  });
});

describe("cleanupSshSigning", () => {
  test("removes the key written by setup", () => {
    probe("setup", DUMMY_KEY);
    expect(existsSync(keyPath)).toBe(true);

    expect(probe("cleanup")).toEqual({ ok: true });

    expect(existsSync(keyPath)).toBe(false);
  });

  test("is a no-op when no key was written", () => {
    expect(probe("cleanup")).toEqual({ ok: true });
  });
});
