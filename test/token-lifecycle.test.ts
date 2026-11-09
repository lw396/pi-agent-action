import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startGitHubTokenLifecycle,
  type GitHubTokenLifecycle,
} from "../src/github/token-lifecycle";

const ENV_NAMES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ADDITIONAL_PERMISSIONS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
] as const;
let saved: Record<string, string | undefined>;
let originalCwd: string;
let dir: string;
let lifecycle: GitHubTokenLifecycle | undefined;
let fetchSpy: ReturnType<typeof spyOn>;
let timerSpy: ReturnType<typeof spyOn>;
let refresh: (() => void) | undefined;
const requests: Array<{ url: string; authorization: string | null }> = [];

beforeEach(() => {
  saved = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  for (const name of ENV_NAMES) delete process.env[name];
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "pi-token-lifecycle-"));
  execFileSync("git", ["init", dir], {
    stdio: "pipe",
    env: { ...process.env },
  });
  process.chdir(dir);
  execFileSync(
    "git",
    [
      "remote",
      "add",
      "origin",
      "https://x-access-token:initial@github.com/owner/repo.git",
    ],
    { env: { ...process.env } },
  );
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.example/token";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token";
  requests.length = 0;
  refresh = undefined;
  const nativeSetTimeout = global.setTimeout;
  timerSpy = spyOn(global, "setTimeout").mockImplementation(((
    callback: () => void,
    delay: number,
    ...args: unknown[]
  ) => {
    if (delay === 45 * 60_000) {
      refresh = callback;
      return { unref() {} };
    }
    return nativeSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  fetchSpy = spyOn(global, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.startsWith("https://oidc.example"))
      return Response.json({ value: "oidc-value" });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ token: "refreshed-token" });
  }) as typeof fetch);
});

const originalFetch = global.fetch;
afterEach(async () => {
  await lifecycle?.stop();
  lifecycle = undefined;
  fetchSpy.mockRestore();
  timerSpy.mockRestore();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("an input token never starts app refresh, even when OIDC is available", async () => {
  lifecycle = startGitHubTokenLifecycle({
    token: "input-token",
    source: "input",
  });
  expect(lifecycle.token).toBe("input-token");
  expect(process.env.GH_TOKEN).toBe("input-token");
  expect(process.env.GITHUB_TOKEN).toBe("input-token");
  expect(lifecycle.broker).toBeUndefined();
  expect(refresh).toBeUndefined();
  await lifecycle.stop();
  expect(requests).toEqual([]);
});

test("refresh updates token, client, env, origin and broker; stop revokes only replaced tokens", async () => {
  lifecycle = startGitHubTokenLifecycle({ token: "initial", source: "app" });
  const clientBefore = lifecycle.octokit;
  const broker = lifecycle.broker!;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  refresh!();
  // The clock callback starts asynchronous work. Observe its public result,
  // then stop() waits for the remote update and drains replaced-token revocation.
  for (let i = 0; i < 100 && lifecycle.token !== "refreshed-token"; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(lifecycle.token).toBe("refreshed-token");
  const response = await originalFetch(broker.url, {
    headers: { Authorization: `Bearer ${broker.key}` },
  });
  expect(await response.text()).toBe("refreshed-token");
  await lifecycle.stop();
  expect(lifecycle.octokit).not.toBe(clientBefore);
  expect(process.env.GH_TOKEN).toBe("refreshed-token");
  expect(process.env.GITHUB_TOKEN).toBe("refreshed-token");
  expect(
    execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      env: { ...process.env },
    }).trim(),
  ).toBe("https://x-access-token:refreshed-token@github.com/owner/repo.git");
  expect(
    requests.some(
      (r) =>
        r.url.endsWith("/installation/token") &&
        r.authorization === "Bearer initial",
    ),
  ).toBe(true);
  expect(
    requests.some((r) => r.authorization === "Bearer refreshed-token"),
  ).toBe(false);
  await expect(
    originalFetch(broker.url, {
      headers: { Authorization: `Bearer ${broker.key}` },
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow();
});
