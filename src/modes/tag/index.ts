import { checkHumanActor } from "../../github/validation/actor";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { setupBranch } from "../../github/operations/branch";
import {
  configureGitAuth,
  replaceCheckoutCredentials,
  setupSshSigning,
} from "../../github/operations/git-config";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  fetchGitHubData,
  resolveTriggerTimestamp,
  extractOriginalTitle,
  extractOriginalBody,
} from "../../github/data/fetcher";
import { createPrompt } from "../../create-prompt";
import { isEntityContext } from "../../github/context";
import type { GitHubContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { ruleToolNames } from "../../runner/tool-rules";

/**
 * Prepares the tag mode execution context.
 *
 * Tag mode responds to @claude mentions, issue assignments, or labels.
 * Creates tracking comments showing progress and has full implementation capabilities.
 */
export async function prepareTagMode({
  context,
  octokit,
  githubToken,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
}) {
  // Tag mode only handles entity-based events
  if (!isEntityContext(context)) {
    throw new Error("Tag mode requires entity context");
  }

  // Check if actor is human
  await checkHumanActor(octokit.rest, context);

  // Create initial tracking comment
  const commentData = await createInitialComment(octokit.rest, context);
  const commentId = commentData.id;

  const triggerTime = await resolveTriggerTimestamp(context, octokit);
  const originalTitle = extractOriginalTitle(context);
  const originalBody = extractOriginalBody(context);

  const githubData = await fetchGitHubData({
    octokits: octokit,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: context.isPR,
    triggerUsername: context.actor,
    triggerTime,
    originalTitle,
    originalBody,
    includeCommentsByActor: context.inputs.includeCommentsByActor,
    excludeCommentsByActor: context.inputs.excludeCommentsByActor,
  });

  // Setup branch
  const branchInfo = await setupBranch(octokit, githubData, context);

  // Configure git authentication
  // SSH signing takes precedence if provided
  const useSshSigning = !!context.inputs.sshSigningKey;
  const useApiCommitSigning = context.inputs.useCommitSigning && !useSshSigning;

  if (useSshSigning) {
    // Setup SSH signing for commits
    await setupSshSigning(context.inputs.sshSigningKey);

    // Still configure git auth for push operations (user/email and remote URL)
    const user = {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId),
    };
    try {
      await configureGitAuth(githubToken, context, user);
    } catch (error) {
      console.error("Failed to configure git authentication:", error);
      throw error;
    }
  } else if (!useApiCommitSigning) {
    // Use bot_id and bot_name from inputs directly
    const user = {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId),
    };

    try {
      await configureGitAuth(githubToken, context, user);
    } catch (error) {
      console.error("Failed to configure git authentication:", error);
      throw error;
    }
  } else {
    // Commits go through the GitHub API, so no git user setup is needed, but
    // the credential actions/checkout left in git config should still be
    // replaced with the action's own.
    try {
      await replaceCheckoutCredentials(githubToken, context);
    } catch (error) {
      console.error("Failed to configure git credentials:", error);
      throw error;
    }
  }

  // Create prompt file
  await createPrompt(
    commentId,
    branchInfo.baseBranch,
    branchInfo.claudeBranch,
    githubData,
    context,
  );

  // The action's own MCP tools the workflow allows, which decide the extra
  // MCP servers to start (the inline comment server, for example).
  const userAllowedMCPTools = ruleToolNames(
    process.env.INPUT_ALLOWED_TOOLS,
  ).filter((tool) => tool.startsWith("mcp__github_"));

  const gitPushWrapper = `${process.env.GITHUB_ACTION_PATH}/scripts/git-push.sh`;

  // Rules tag mode adds to the allowed_tools input.
  // Edit/MultiEdit/Write are intentionally omitted: acceptEdits (returned below)
  // lets the Runner allow file edits inside $GITHUB_WORKSPACE and block writes
  // outside (e.g. ~/.bashrc). Listing them here would grant blanket write
  // access to the whole runner (Asana 1213310082312048).
  const tagModeTools = [
    "Glob",
    "Grep",
    "LS",
    "Read",
    "mcp__github_comment__update_comment",
    "mcp__github_ci__get_ci_status",
    "mcp__github_ci__get_workflow_run_details",
    "mcp__github_ci__download_job_log",
    ...userAllowedMCPTools,
  ];

  // Add git commands when using git CLI (no API commit signing, or SSH signing)
  // SSH signing still uses git CLI, just with signing enabled
  if (!useApiCommitSigning) {
    tagModeTools.push(
      "Bash(git add:*)",
      "Bash(git commit:*)",
      `Bash(${gitPushWrapper}:*)`,
      "Bash(git rm:*)",
    );
  } else {
    // When using API commit signing, use MCP file ops tools
    tagModeTools.push(
      "mcp__github_file_ops__commit_files",
      "mcp__github_file_ops__delete_files",
    );
  }
  const allowedTools = Array.from(new Set(tagModeTools));

  // Get our GitHub MCP servers configuration
  const ourMcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: branchInfo.claudeBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    claudeCommentId: commentId.toString(),
    allowedTools,
    mode: "tag",
    context,
  });

  return {
    commentId,
    branchInfo,
    mcpConfig: ourMcpConfig,
    allowedTools,
    acceptEdits: true,
  };
}
