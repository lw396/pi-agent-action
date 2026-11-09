import type { Octokits } from "../github/api/client";
import {
  updateCommentBody,
  type CommentUpdateInput,
} from "../github/operations/comment-logic";
import type { ParsedGitHubContext } from "../github/context";
import { GITHUB_SERVER_URL } from "../github/api/config";
import { checkAndCommitOrDeleteBranch } from "../github/operations/branch-cleanup";
import { updateComment } from "../github/operations/comments/update-comment";
import { encodeBranchNameForUrl } from "../github/operations/comments/common";
import type { TrackingComment } from "../github/operations/comments/tracking-comment";
import {
  readExecutionFile,
  sessionStats,
  type ExecutionRecord,
} from "../runner/execution-file";

type ExecutionDetails = {
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
};

/**
 * The run's cost and duration, from the session_stats record that ends the
 * Runner's Execution file. Upstream read Claude Code's closing result message.
 */
export function executionDetailsFrom(
  records: ExecutionRecord[],
): ExecutionDetails | null {
  const stats = sessionStats(records);
  if (!stats) return null;
  return { total_cost_usd: stats.cost, duration_ms: stats.durationMs };
}

export type UpdateCommentLinkParams = {
  trackingComment: TrackingComment;
  agentBranch?: string;
  baseBranch: string;
  triggerUsername?: string;
  context: ParsedGitHubContext;
  octokit: Octokits;
  agentSuccess: boolean;
  outputFile?: string;
  prepareSuccess: boolean;
  prepareError?: string;
  useCommitSigning: boolean;
  /**
   * Paths restored from the PR base branch by restoreConfigFromBase. The
   * auto-commit in checkAndCommitOrDeleteBranch must leave these alone, or it
   * commits the revert onto the PR author's branch.
   */
  restoredConfigPaths?: string[];
  /** What happened to a failed run's unfinished work, for the comment. */
  wipNote?: string;
};

export async function updateCommentLink(
  params: UpdateCommentLinkParams,
): Promise<void> {
  const {
    trackingComment,
    agentBranch,
    baseBranch,
    triggerUsername,
    context,
    octokit,
    useCommitSigning,
    restoredConfigPaths = [],
  } = params;

  const { owner, repo } = context.repository;

  const serverUrl = GITHUB_SERVER_URL;
  const jobUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

  let currentBody: string;
  try {
    const { data: comment } =
      trackingComment.namespace === "review"
        ? await octokit.rest.pulls.getReviewComment({
            owner,
            repo,
            comment_id: trackingComment.id,
          })
        : await octokit.rest.issues.getComment({
            owner,
            repo,
            comment_id: trackingComment.id,
          });
    currentBody = comment.body ?? "";
  } catch (error) {
    console.error(
      `Failed to fetch ${trackingComment.namespace} comment ${trackingComment.id} in ${context.repository.full_name}`,
      error,
    );
    throw error;
  }

  // Check if we need to add branch link for new branches
  const { shouldDeleteBranch, branchLink } = await checkAndCommitOrDeleteBranch(
    octokit,
    owner,
    repo,
    agentBranch,
    baseBranch,
    useCommitSigning,
    restoredConfigPaths,
  );

  // Check if we need to add PR URL when we have a new branch
  let prLink = "";
  // If agentBranch is set, it means we created a new branch (for issues or closed/merged PRs).
  // branchLink is empty when that branch was never pushed or was deleted as empty.
  if (agentBranch && branchLink) {
    // Check if comment already contains a PR URL
    const serverUrlPattern = serverUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prUrlPattern = new RegExp(
      `${serverUrlPattern}\\/.+\\/compare\\/${baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\.\\.`,
    );
    const containsPRUrl = currentBody.match(prUrlPattern);

    if (!containsPRUrl) {
      // Check if there are changes to the branch compared to the default branch
      try {
        const { data: comparison } =
          await octokit.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${baseBranch}...${agentBranch}`,
          });

        // If there are changes (commits or file changes), add the PR URL
        if (
          comparison.total_commits > 0 ||
          (comparison.files && comparison.files.length > 0)
        ) {
          const entityType = context.isPR ? "PR" : "Issue";
          const prTitle = encodeURIComponent(
            `${entityType} #${context.entityNumber}: Changes from pi`,
          );
          const prBody = encodeURIComponent(
            `This PR addresses ${entityType.toLowerCase()} #${context.entityNumber}`,
          );
          const prUrl = `${serverUrl}/${owner}/${repo}/compare/${encodeBranchNameForUrl(baseBranch)}...${encodeBranchNameForUrl(agentBranch)}?quick_pull=1&title=${prTitle}&body=${prBody}`;
          prLink = `\n[Create a PR](${prUrl})`;
        }
      } catch (error) {
        console.error("Error checking for changes in branch:", error);
        // Don't fail the entire update if we can't check for changes
      }
    }
  }

  // Check if action failed and read output file for execution details
  let executionDetails: ExecutionDetails | null = null;
  let actionFailed = false;
  let errorDetails: string | undefined;

  if (!params.prepareSuccess && params.prepareError) {
    actionFailed = true;
    errorDetails = params.prepareError;
  } else {
    // Check for existence of output file and parse it if available
    try {
      if (params.outputFile) {
        executionDetails = executionDetailsFrom(
          readExecutionFile(params.outputFile),
        );
      }

      actionFailed = !params.agentSuccess;
    } catch (error) {
      console.error("Error reading output file:", error);
      actionFailed = !params.agentSuccess;
    }
  }

  // Prepare input for updateCommentBody function
  const commentInput: CommentUpdateInput = {
    currentBody,
    actionFailed,
    executionDetails,
    jobUrl,
    branchLink,
    prLink,
    branchName: shouldDeleteBranch || !branchLink ? undefined : agentBranch,
    triggerUsername,
    errorDetails,
    wipNote: params.wipNote,
  };

  const updatedBody = updateCommentBody(commentInput);

  try {
    await updateComment(octokit.rest, {
      owner,
      repo,
      comment: trackingComment,
      body: updatedBody,
    });
    console.log(
      `✅ Updated ${trackingComment.namespace === "review" ? "PR review" : "issue"} comment ${trackingComment.id} with job link`,
    );
  } catch (updateError) {
    console.error(
      `Failed to update ${trackingComment.namespace} comment ${trackingComment.id}:`,
      updateError,
    );
    throw updateError;
  }
}
