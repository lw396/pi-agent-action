import type { Octokit } from "@octokit/rest";
import { redactSecrets, sanitizeContent } from "../../../security/sanitizer";

/** A review comment to post on a pull request. */
export type InlineComment = {
  path: string;
  body: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  /** The commit to comment on; the pull request's head commit by default. */
  commitId?: string;
};

export type PostedInlineComment = {
  id: number;
  htmlUrl: string;
  path: string;
  line?: number;
};

/** The comment body as GitHub gets it: hidden content removed, secrets redacted. */
export function inlineCommentBody(body: string): string {
  return redactSecrets(sanitizeContent(body));
}

/** Throws unless the comment names a line, or both a start line and a line. */
export function assertInlineCommentLines(
  comment: Pick<InlineComment, "line" | "startLine">,
): void {
  if (!comment.line && !comment.startLine) {
    throw new Error(
      "Either 'line' for single-line comments or both 'startLine' and 'line' for multi-line comments must be provided",
    );
  }
}

/**
 * Post a prepared comment body without interpreting its Markdown again.
 * Buffered bodies were already sanitized when captured; another sanitization
 * pass could decode literal entities twice. Redact again for the post-step's
 * current secret values. `headSha` resolves an unpinned comment's commit.
 */
export async function postInlineComment(
  octokit: Octokit,
  target: { owner: string; repo: string; pullNumber: number },
  comment: InlineComment,
  headSha: () => Promise<string>,
): Promise<PostedInlineComment> {
  assertInlineCommentLines(comment);

  const side = comment.side || "RIGHT";
  const params: Parameters<typeof octokit.rest.pulls.createReviewComment>[0] = {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    body: redactSecrets(comment.body),
    path: comment.path,
    side,
    commit_id: comment.commitId || (await headSha()),
    line: comment.line,
  };
  if (comment.startLine) {
    params.start_line = comment.startLine;
    params.start_side = side;
  }

  const result = await octokit.rest.pulls.createReviewComment(params);
  return {
    id: result.data.id,
    htmlUrl: result.data.html_url,
    path: result.data.path,
    line: result.data.line || result.data.original_line,
  };
}
