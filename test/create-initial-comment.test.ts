import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { createInitialComment } from "../src/github/operations/comments/create-initial";
import {
  mockPullRequestOpenedContext,
  mockPullRequestReviewCommentContext,
} from "./mockContext";

const stickyContext = {
  ...mockPullRequestOpenedContext,
  inputs: { ...mockPullRequestOpenedContext.inputs, useStickyComment: true },
};

describe("createInitialComment", () => {
  let outputDir: string;
  let originalOutput: string | undefined;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "create-initial-"));
    originalOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = join(outputDir, "output");
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
    rmSync(outputDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function output(): string {
    return readFileSync(process.env.GITHUB_OUTPUT!, "utf8");
  }

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

  test("returns the issue namespace for a sticky comment it reuses", async () => {
    const { octokit } = octokitWithComments([
      {
        id: 7,
        body: "an older status",
        user: { id: 339978130, login: "pi-agent-action[bot]", type: "Bot" },
      },
    ]);

    const comment = await createInitialComment(octokit, stickyContext);

    expect(comment).toEqual({ id: 7, namespace: "issue" });
    expect(output()).toContain("tracking_comment_id=7");
  });

  test("replies to the review comment it was triggered by", async () => {
    const replies: unknown[] = [];
    const octokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: async (params: unknown) => {
            replies.push(params);
            return { data: { id: 11 } };
          },
        },
        issues: {
          createComment: async () => {
            throw new Error("not an issue comment");
          },
        },
      },
    } as unknown as Octokit;

    const comment = await createInitialComment(
      octokit,
      mockPullRequestReviewCommentContext,
    );

    expect(replies).toEqual([
      {
        owner: "test-owner",
        repo: "test-repo",
        pull_number: 999,
        comment_id: 99988877,
        body: expect.any(String),
      },
    ]);
    expect(comment).toEqual({ id: 11, namespace: "review" });
    expect(output()).toContain("tracking_comment_id=11");
  });

  test("falls back to an issue comment, and reports its namespace, when the reply fails", async () => {
    const created: unknown[] = [];
    const octokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: async () => {
            throw new Error("Validation Failed");
          },
        },
        issues: {
          createComment: async (params: unknown) => {
            created.push(params);
            return { data: { id: 12 } };
          },
        },
      },
    } as unknown as Octokit;

    const comment = await createInitialComment(
      octokit,
      mockPullRequestReviewCommentContext,
    );

    expect(created).toHaveLength(1);
    expect(comment).toEqual({ id: 12, namespace: "issue" });
    expect(output()).toContain("tracking_comment_id=12");
  });
});
