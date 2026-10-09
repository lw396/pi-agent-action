import { describe, expect, test } from "bun:test";
import { updateCommentLink } from "../src/entrypoints/update-comment-link";
import { mockPullRequestReviewCommentContext } from "./mockContext";

describe("updateCommentLink", () => {
  test("updates the issue comment created in place of a review comment reply", async () => {
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const updatedBodies: string[] = [];
    const rest: any = {
      pulls: {
        getReviewComment: async () => {
          throw notFound;
        },
        updateReviewComment: async () => {
          throw notFound;
        },
      },
      issues: {
        getComment: async () => ({
          data: { id: 7, body: 'pi is working… <img src="spinner">' },
        }),
        updateComment: async ({ body }: { body: string }) => {
          updatedBodies.push(body);
          return { data: { id: 7, html_url: "", updated_at: "" } };
        },
      },
    };
    // updateComment takes octokit.rest, and Octokit exposes .rest on it too.
    rest.rest = rest;
    const octokit = { rest } as any;

    await updateCommentLink({
      commentId: 7,
      githubToken: "test-token",
      baseBranch: "main",
      context: mockPullRequestReviewCommentContext,
      octokit,
      agentSuccess: true,
      prepareSuccess: true,
      useCommitSigning: false,
    });

    expect(updatedBodies).toHaveLength(1);
    expect(updatedBodies[0]).not.toContain("spinner");
  });
});
