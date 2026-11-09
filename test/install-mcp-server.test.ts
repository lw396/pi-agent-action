import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { prepareMcpConfig } from "../src/mcp/install-mcp-server";

type Config = Parameters<typeof prepareMcpConfig>[0];
const pullRequest = { number: 456, classifyInlineComments: true };
const fileOps = { branch: "feature", baseBranch: "main" };
const env = {
  GITHUB_ACTION_PATH: "/action",
  GITHUB_WORKSPACE: "/checkout",
  RUNNER_TEMP: "/run-temp",
  DEFAULT_WORKFLOW_TOKEN: "workflow-token",
};
function configure(options: Partial<Config> = {}) {
  return prepareMcpConfig({
    githubToken: "app-token",
    owner: "owner",
    repo: "repo",
    allowedTools: [],
    env,
    ...options,
  });
}

let fetchSpy: ReturnType<typeof spyOn>;
let warningSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fetchSpy = spyOn(global, "fetch").mockResolvedValue(
    Response.json({ workflow_runs: [] }),
  );
  warningSpy = spyOn(core, "warning").mockImplementation(() => {});
});
afterEach(() => {
  fetchSpy.mockRestore();
  warningSpy.mockRestore();
});

describe("MCP server selection", () => {
  test("does not start servers without tool grants or signing capability", async () => {
    expect(await configure()).toEqual({});
    expect(
      await configure({ allowedTools: ["Bash", "Read", "Grep", "mcp__*"] }),
    ).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["mcp__github_comment", "github_comment"],
    ["mcp__github_comment__update_comment", "github_comment"],
    ["mcp__github_comment__*", "github_comment"],
    ["mcp__github_ci", "github_ci"],
    ["mcp__github_ci__get_ci_status", "github_ci"],
    ["mcp__github_inline_comment", "github_inline_comment"],
    [
      "mcp__github_inline_comment__create_inline_comment",
      "github_inline_comment",
    ],
  ])("starts the server named by %s", async (tool, name) => {
    expect(
      Object.keys(await configure({ allowedTools: [tool], pullRequest })),
    ).toEqual([name]);
  });

  test("starts GitHub's docker server and inline comments for GitHub tool grants on PRs", async () => {
    for (const tool of ["mcp__github", "mcp__github__create_issue"]) {
      const servers = await configure({ allowedTools: [tool], pullRequest });
      expect(Object.keys(servers).sort()).toEqual([
        "github",
        "github_inline_comment",
      ]);
      expect(servers.github).toMatchObject({
        command: "docker",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "app-token" },
      });
    }
  });

  test("does not start PR-only servers without a PR", async () => {
    expect(
      await configure({
        allowedTools: ["mcp__github_inline_comment", "mcp__github_ci"],
      }),
    ).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("requires a workflow token and actions:read before starting CI", async () => {
    const request = { allowedTools: ["mcp__github_ci"], pullRequest };
    expect(
      await configure({
        ...request,
        env: { ...env, DEFAULT_WORKFLOW_TOKEN: undefined },
      }),
    ).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValue(
      Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403 },
      ),
    );
    expect(await configure(request)).toEqual({});
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining("actions: read"),
    );
  });

  test("does not probe CI permissions when CI tools were not requested", async () => {
    await configure({ allowedTools: ["mcp__github_comment"], pullRequest });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

test("passes comment identity and PR classification policy explicitly", async () => {
  const servers = await configure({
    allowedTools: ["mcp__github_comment", "mcp__github_inline_comment"],
    trackingComment: { id: 987, namespace: "review" },
    pullRequest: { ...pullRequest, classifyInlineComments: false },
  });
  expect(servers.github_comment).toMatchObject({
    env: {
      REPO_OWNER: "owner",
      REPO_NAME: "repo",
      TRACKING_COMMENT_ID: "987",
      TRACKING_COMMENT_NAMESPACE: "review",
    },
  });
  expect(servers.github_inline_comment).toMatchObject({
    env: {
      PR_NUMBER: "456",
      CLASSIFY_INLINE_COMMENTS: "false",
      INLINE_COMMENT_BUFFER: "/run-temp/pi-inline-comments.jsonl",
    },
  });
});

test("passes fresh-token broker addresses to owned servers but the workflow token to CI", async () => {
  const servers = await configure({
    allowedTools: [
      "mcp__github_comment",
      "mcp__github_inline_comment",
      "mcp__github_ci",
    ],
    pullRequest,
    fileOps,
    tokenBroker: { url: "http://127.0.0.1:1234/", key: "broker-key" },
  });
  for (const name of [
    "github_comment",
    "github_file_ops",
    "github_inline_comment",
  ]) {
    expect(servers[name]).toMatchObject({
      env: {
        GITHUB_TOKEN_BROKER_URL: "http://127.0.0.1:1234/",
        GITHUB_TOKEN_BROKER_KEY: "broker-key",
      },
    });
    const server = servers[name]!;
    expect(
      "command" in server ? server.env?.GITHUB_TOKEN : undefined,
    ).toBeUndefined();
  }
  expect(servers.github_ci).toMatchObject({
    env: { GITHUB_TOKEN: "workflow-token", PR_NUMBER: "456" },
  });
});

test("pins Bun runtime flags and signing paths for every owned server", async () => {
  const servers = await configure({
    allowedTools: [
      "mcp__github_comment",
      "mcp__github_inline_comment",
      "mcp__github_ci",
    ],
    pullRequest,
    fileOps,
  });
  const scripts = {
    github_comment: "github-comment-server",
    github_file_ops: "github-file-ops-server",
    github_inline_comment: "github-inline-comment-server",
    github_ci: "github-actions-server",
  };
  for (const [name, script] of Object.entries(scripts)) {
    expect(servers[name]).toMatchObject({
      command: "bun",
      args: [
        "--no-env-file",
        "--config=/action/bunfig.toml",
        "run",
        `/action/src/mcp/${script}.ts`,
      ],
    });
  }
  expect(servers.github_file_ops).toMatchObject({
    env: {
      GITHUB_TOKEN: "app-token",
      BRANCH_NAME: "feature",
      BASE_BRANCH: "main",
      REPO_DIR: "/checkout",
    },
  });
  const fallback = await configure({ fileOps, env: {} });
  expect(fallback.github_file_ops).toMatchObject({
    env: { REPO_DIR: process.cwd() },
  });
});

test("redacts secrets in configuration errors without exiting the process", async () => {
  const token = `ghp_${"a".repeat(36)}`;
  const tools = {
    some() {
      throw new Error(`request with ${token} failed`);
    },
  } as unknown as string[];
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("unexpected exit");
  });
  try {
    await expect(configure({ allowedTools: tools })).rejects.toThrow(
      "Install MCP server failed with error: Error: request with [REDACTED_GITHUB_TOKEN] failed",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});
