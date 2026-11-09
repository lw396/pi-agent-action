// The shared inline comment posting the live MCP tool and the buffered
// post-step both use: parameters, redaction and head commit resolution.
import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import {
  inlineCommentBody,
  postInlineComment,
} from "../src/github/operations/comments/inline-comment";

const target = { owner: "owner", repo: "repo", pullNumber: 7 };

function octokitRecorder() {
  const params: any[] = [];
  const octokit = {
    rest: {
      pulls: {
        createReviewComment: async (p: any) => {
          params.push(p);
          return {
            data: {
              id: 42,
              html_url: "https://github.com/owner/repo/pull/7#r42",
              path: p.path,
              line: p.line,
              original_line: p.line,
            },
          };
        },
      },
    },
  } as unknown as Octokit;
  return { octokit, params };
}

describe("postInlineComment", () => {
  test("posts a single-line comment on the head commit, redacting secrets", async () => {
    const { octokit, params } = octokitRecorder();
    const token = `ghp_${"a".repeat(36)}`;

    const posted = await postInlineComment(
      octokit,
      target,
      { path: "src/a.ts", body: `Nice\n${token}`, line: 12 },
      async () => "head-sha",
    );

    expect(params).toEqual([
      {
        owner: "owner",
        repo: "repo",
        pull_number: 7,
        body: "Nice\n[REDACTED_GITHUB_TOKEN]",
        path: "src/a.ts",
        side: "RIGHT",
        commit_id: "head-sha",
        line: 12,
      },
    ]);
    expect(posted).toEqual({
      id: 42,
      htmlUrl: "https://github.com/owner/repo/pull/7#r42",
      path: "src/a.ts",
      line: 12,
    });
  });

  test("posts a multi-line comment on the side it names", async () => {
    const { octokit, params } = octokitRecorder();

    await postInlineComment(
      octokit,
      target,
      {
        path: "src/a.ts",
        body: "Suggestion",
        line: 20,
        startLine: 15,
        side: "LEFT",
      },
      async () => "head-sha",
    );

    expect(params[0]).toMatchObject({
      side: "LEFT",
      start_line: 15,
      start_side: "LEFT",
      line: 20,
    });
  });

  test("keeps the commit the caller names instead of resolving the head", async () => {
    const { octokit, params } = octokitRecorder();

    await postInlineComment(
      octokit,
      target,
      { path: "src/a.ts", body: "x", line: 1, commitId: "pinned-sha" },
      async () => {
        throw new Error("head SHA must not be resolved");
      },
    );

    expect(params[0].commit_id).toBe("pinned-sha");
  });

  test("rejects a comment without a line", async () => {
    const { octokit, params } = octokitRecorder();

    await expect(
      postInlineComment(
        octokit,
        target,
        { path: "src/a.ts", body: "x" },
        async () => "head-sha",
      ),
    ).rejects.toThrow(
      "Either 'line' for single-line comments or both 'startLine' and 'line' for multi-line comments must be provided",
    );
    expect(params).toEqual([]);
  });

  test("posts a buffered body without decoding its literal entities twice", async () => {
    const { octokit, params } = octokitRecorder();
    const body = inlineCommentBody("&#38;#65; <!-- hidden -->");
    await postInlineComment(
      octokit,
      target,
      { path: "src/a.ts", body, line: 1 },
      async () => "head-sha",
    );
    expect(params[0].body).toBe("&#65; ");
  });
});
