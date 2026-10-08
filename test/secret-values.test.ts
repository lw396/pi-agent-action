// Redaction by value (issue #13): environment values outside the bash env
// allowlist count as secrets wherever they turn up, raw, base64 or URL-encoded,
// except the action's own non-secret settings and existing paths.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import {
  ACTION_SETTINGS_ENV,
  collectSecretValues,
  redactSecretValues,
} from "../src/github/utils/secret-values";
import { redactSecrets } from "../src/github/utils/sanitizer";

// No known format, so only redaction by value can catch it.
const SECRET = "oc-7f3a9b2c1d4e5f60a7b8c9d0e1f2a3b4";

const base64 = (text: string) => Buffer.from(text).toString("base64");

afterEach(() => {
  collectSecretValues({});
});

describe("redactSecretValues", () => {
  test("replaces a secret's raw value", () => {
    collectSecretValues({ OPENCODE_API_KEY: SECRET });
    expect(redactSecretValues(`key is ${SECRET}.`)).toBe("key is [REDACTED].");
  });

  test("replaces a secret's URL-encoded form", () => {
    const secret = "pass/word+with=chars&more";
    collectSecretValues({ DB_PASSWORD: secret });
    const url = `https://example.com/?p=${encodeURIComponent(secret)}`;
    expect(redactSecretValues(url)).toBe("https://example.com/?p=[REDACTED]");
  });

  test("replaces a secret base64-encoded on its own", () => {
    collectSecretValues({ OPENCODE_API_KEY: SECRET });
    expect(redactSecretValues(`auth: ${base64(SECRET)}`)).toBe(
      "auth: [REDACTED]",
    );
  });

  // In a larger base64 blob, the secret's characters depend on where it
  // starts relative to the 3-byte groups.
  test.each([0, 1, 2])(
    "replaces a secret base64-encoded inside other text, %i bytes past a group boundary",
    (offset) => {
      collectSecretValues({ OPENCODE_API_KEY: SECRET });
      const blob = base64(
        `${"x".repeat(30 + offset)}${SECRET}${"y".repeat(30)}`,
      );
      const redacted = redactSecretValues(blob);
      expect(redacted).toContain("[REDACTED]");
      // What is left on either side encodes the padding, plus at most two
      // characters that mix padding and secret bits.
      const [before, after] = redacted.split("[REDACTED]");
      expect(before!.length).toBeLessThanOrEqual(base64("x".repeat(33)).length);
      expect(after!.length).toBeLessThanOrEqual(base64("y".repeat(33)).length);
    },
  );

  test("leaves values shorter than 16 characters alone", () => {
    collectSecretValues({ SHORT_TOKEN: "abc123def456" });
    expect(redactSecretValues("abc123def456")).toBe("abc123def456");
  });

  test("leaves the values of allowlisted variables alone", () => {
    const workspace = "/home/runner/work/repo/repo";
    collectSecretValues({
      GITHUB_WORKSPACE: workspace,
      // Same value under a name outside the allowlist: still not a secret.
      PWD: workspace,
    });
    expect(redactSecretValues(`cd ${workspace}`)).toBe(`cd ${workspace}`);
  });

  test("leaves the action's own non-secret settings alone", () => {
    const prompt = "Review this pull request and summarise the changes.";
    collectSecretValues({ PROMPT: prompt, MODEL: "opencode/gpt-6-luna" });
    expect(redactSecretValues(`${prompt} (opencode/gpt-6-luna)`)).toBe(
      `${prompt} (opencode/gpt-6-luna)`,
    );
  });

  test("still redacts the action's secret settings", () => {
    const secrets = {
      API_KEY: SECRET,
      OVERRIDE_GITHUB_TOKEN: "token-from-the-github-token-input",
      SSH_SIGNING_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----abc",
      // Free-form pass-through arguments.
      PI_ARGS: "--append-system-prompt 'use key 0123456789abcdef'",
      // Copied from the workflow env, not an input.
      NODE_VERSION: "secret-in-the-workflow-env",
      // The serialized inputs, api_key and github_token included.
      ALL_INPUTS: `{"api_key":"${SECRET}"}`,
    };
    collectSecretValues(secrets);
    for (const value of Object.values(secrets)) {
      expect(redactSecretValues(`<${value}>`)).toBe("<[REDACTED]>");
    }
  });

  test("leaves values that are existing absolute paths, or lists of them, alone", () => {
    const dir = import.meta.dir;
    const list = [tmpdir(), process.cwd()].join(delimiter);
    collectSecretValues({ RUNNER_TEMP: dir, SOME_PATH_LIST: list });
    expect(redactSecretValues(`${dir} and ${list}`)).toBe(`${dir} and ${list}`);
  });

  test("redacts a path-shaped value that does not exist", () => {
    const value = "/no/such/directory/a1b2c3d4";
    collectSecretValues({ STRANGE_SECRET: value });
    expect(redactSecretValues(value)).toBe("[REDACTED]");
  });

  test("lists only settings the run step sets", () => {
    const metadata = readFileSync(
      new URL("../action.yml", import.meta.url),
      "utf8",
    );
    for (const name of ACTION_SETTINGS_ENV) {
      expect(metadata).toContain(`        ${name}: \${{`);
    }
  });

  test("redacts nothing until values are collected", () => {
    expect(redactSecretValues(SECRET)).toBe(SECRET);
  });
});

describe("redactSecrets", () => {
  test("also redacts by value", () => {
    collectSecretValues({ OPENCODE_API_KEY: SECRET });
    expect(redactSecrets(`Error: bad key ${SECRET}`)).toBe(
      "Error: bad key [REDACTED]",
    );
  });
});
