import type {
  GitHubPullRequest,
  GitHubIssue,
  GitHubComment,
  GitHubReview,
} from "../types";
import type { GitHubFileWithSHA } from "./fetcher";
import { sanitizeContent } from "../../security/sanitizer";

function formatLabels(labelNodes: Array<{ name: string }>): string {
  if (labelNodes.length === 0) return "none";
  return labelNodes.map((l) => l.name).join(", ");
}

export function formatContext(
  contextData: GitHubPullRequest | GitHubIssue,
  isPR: boolean,
): string {
  if (isPR) {
    const prData = contextData as GitHubPullRequest;
    const sanitizedTitle = sanitizeContent(prData.title);
    return `PR Title: ${sanitizedTitle}
PR Author: ${prData.author?.login ?? "ghost"}
PR Branch: ${prData.headRefName} -> ${prData.baseRefName}
PR State: ${prData.state}
PR Labels: ${formatLabels(prData.labels.nodes)}
PR Additions: ${prData.additions}
PR Deletions: ${prData.deletions}
Total Commits: ${prData.commits.totalCount}
Changed Files: ${prData.files ? `${prData.files.nodes.length} files` : "unknown (file list unavailable)"}`;
  } else {
    const issueData = contextData as GitHubIssue;
    const sanitizedTitle = sanitizeContent(issueData.title);
    return `Issue Title: ${sanitizedTitle}
Issue Author: ${issueData.author?.login ?? "ghost"}
Issue State: ${issueData.state}
Issue Labels: ${formatLabels(issueData.labels.nodes)}`;
  }
}

export function formatBody(
  body: string,
  imageUrlMap: Map<string, string>,
): string {
  let processedBody = body;

  for (const [originalUrl, localPath] of imageUrlMap) {
    processedBody = processedBody.replaceAll(originalUrl, localPath);
  }

  processedBody = sanitizeContent(processedBody);

  return processedBody;
}

export function formatComments(
  comments: GitHubComment[],
  imageUrlMap?: Map<string, string>,
): string {
  return comments
    .filter((comment) => !comment.isMinimized)
    .map((comment) => {
      const body = imageUrlMap
        ? formatBody(comment.body, imageUrlMap)
        : sanitizeContent(comment.body);

      return `[${comment.author?.login ?? "ghost"} at ${comment.createdAt}]: ${body}`;
    })
    .join("\n\n");
}

export function formatReviewComments(
  reviewData: { nodes: GitHubReview[] } | null,
  imageUrlMap?: Map<string, string>,
): string {
  if (!reviewData || !reviewData.nodes) {
    return "";
  }

  const formattedReviews = reviewData.nodes.map((review) => {
    let reviewOutput = `[Review by ${review.author?.login ?? "ghost"} at ${review.submittedAt}]: ${review.state}`;

    if (review.body && review.body.trim()) {
      const sanitizedBody = imageUrlMap
        ? formatBody(review.body, imageUrlMap)
        : sanitizeContent(review.body);
      reviewOutput += `\n${sanitizedBody}`;
    }

    if (
      review.comments &&
      review.comments.nodes &&
      review.comments.nodes.length > 0
    ) {
      const comments = review.comments.nodes
        .filter((comment) => !comment.isMinimized)
        .map((comment) => {
          const body = imageUrlMap
            ? formatBody(comment.body, imageUrlMap)
            : sanitizeContent(comment.body);

          let formatted = `  [Comment on ${comment.path}:${comment.line || "?"}]: ${body}`;

          // The diff hunk is the code the comment was left on. Without it the
          // comment arrives without the context it was written against.
          if (comment.diffHunk) {
            const diffHunk = sanitizeContent(comment.diffHunk);
            formatted += `\n  Diff context:\n\`\`\`diff\n${diffHunk}\n\`\`\``;
          }

          return formatted;
        })
        .join("\n");
      if (comments) {
        reviewOutput += `\n${comments}`;
      }
    }

    return reviewOutput;
  });

  return formattedReviews.join("\n\n");
}

export function formatChangedFilesWithSHA(
  changedFiles: GitHubFileWithSHA[],
): string {
  return changedFiles
    .map(
      (file) =>
        `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions} SHA: ${file.sha}`,
    )
    .join("\n");
}
