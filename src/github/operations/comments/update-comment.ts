import { Octokit } from "@octokit/rest";
import type { TrackingComment } from "./tracking-comment";

export type UpdateCommentParams = {
  owner: string;
  repo: string;
  comment: TrackingComment;
  body: string;
};

export type UpdateCommentResult = {
  id: number;
  html_url: string;
  updated_at: string;
};

/** Update the tracking comment through the API its namespace names. */
export async function updateComment(
  octokit: Octokit,
  params: UpdateCommentParams,
): Promise<UpdateCommentResult> {
  const { owner, repo, comment, body } = params;

  const response =
    comment.namespace === "review"
      ? await octokit.rest.pulls.updateReviewComment({
          owner,
          repo,
          comment_id: comment.id,
          body,
        })
      : await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: comment.id,
          body,
        });

  return {
    id: response.data.id,
    html_url: response.data.html_url,
    updated_at: response.data.updated_at,
  };
}
