import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { createInitialComment } from "../src/github/operations/comments/create-initial";
import { mockPullRequestOpenedContext } from "./mockContext";

const stickyContext = {
  ...mockPullRequestOpenedContext,
  inputs: { ...mockPullRequestOpenedContext.inputs, useStickyComment: true },
};

describe("createInitialComment with use_sticky_comment", () => {
  let outputDir: string;
  let originalOutput: string | undefined;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "create-initial-"));
    originalOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = join(outputDir, "output");
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
    rmSync(outputDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  function octokitWithComments(comments: unknown[]) {
    const calls = { update: [] as unknown[], create: [] as unknown[] };
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: comments }),
          updateComment: async (params: unknown) => {
            calls.update.push(params);
            return { data: { id: 7 } };
          },
          createComment: async (params: unknown) => {
            calls.create.push(params);
            return { data: { id: 8 } };
          },
        },
      },
    } as unknown as Octokit;
    return { octokit, calls };
  }

  test("reuses the comment left by the pi-agent-action app's bot", async () => {
    const { octokit, calls } = octokitWithComments([
      {
        id: 7,
        body: "an older status",
        user: { id: 339978130, login: "pi-agent-action[bot]", type: "Bot" },
      },
    ]);

    await createInitialComment(octokit, stickyContext);

    expect(calls.update).toHaveLength(1);
    expect(calls.create).toHaveLength(0);
  });

  test("does not reuse a comment from another bot", async () => {
    const { octokit, calls } = octokitWithComments([
      {
        id: 5,
        body: "an older status",
        user: { id: 209825114, login: "claude[bot]", type: "Bot" },
      },
    ]);

    await createInitialComment(octokit, stickyContext);

    expect(calls.update).toHaveLength(0);
    expect(calls.create).toHaveLength(1);
  });
});
