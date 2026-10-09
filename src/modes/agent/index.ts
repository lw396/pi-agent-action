import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  configureGitAuth,
  replaceCheckoutCredentials,
  setupSshSigning,
} from "../../github/operations/git-config";
import { checkHumanActor } from "../../github/validation/actor";
import type { PrepareOptions, PrepareResult } from "../types";

/**
 * Prepares the agent mode execution context.
 *
 * Agent mode runs whenever an explicit prompt is provided in the workflow configuration.
 * It bypasses the standard @pi mention checking and comment tracking used by tag mode,
 * running the agent directly for automation workflows.
 */
export async function prepareAgentMode({
  context,
  octokit,
  githubToken,
  allowedTools,
}: PrepareOptions): Promise<PrepareResult> {
  // Check if actor is human (prevents bot-triggered loops)
  await checkHumanActor(octokit.rest, context);

  // Configure git authentication for agent mode (same as tag mode)
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
      // Continue anyway - git operations may still work with default config
    }
  } else if (!useApiCommitSigning) {
    // Use bot_id and bot_name from inputs directly
    const user = {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId),
    };

    try {
      // Use the shared git configuration function
      await configureGitAuth(githubToken, context, user);
    } catch (error) {
      console.error("Failed to configure git authentication:", error);
      // Continue anyway - git operations may still work with default config
    }
  } else {
    // Commits go through the GitHub API, so no git user setup is needed, but
    // the credential actions/checkout left in git config should still be
    // replaced with the action's own.
    try {
      await replaceCheckoutCredentials(githubToken, context);
    } catch (error) {
      console.error("Failed to configure git credentials:", error);
      // Continue anyway - git operations may still work with default config
    }
  }

  const prompt =
    context.inputs.prompt ||
    `Repository: ${context.repository.owner}/${context.repository.repo}`;

  // Check for branch info from environment variables (useful for auto-fix workflows)
  const agentBranch = process.env.AGENT_BRANCH || undefined;
  const defaultBranch = context.repository.default_branch || "main";
  const baseBranch = context.inputs.baseBranch || defaultBranch;

  // Detect current branch from GitHub environment
  const currentBranch =
    agentBranch ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    defaultBranch;

  // The allowed_tools input decides which of the action's MCP servers start
  const mcpServers = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: currentBranch,
    baseBranch: baseBranch,
    trackingCommentId: undefined, // No tracking comment in agent mode
    allowedTools: allowedTools.map((rule) => rule.tool),
    mode: "agent",
    context,
  });

  return {
    prompt,
    commentId: undefined,
    branchInfo: {
      baseBranch: baseBranch,
      currentBranch: baseBranch, // Use base branch as current when creating new branch
      agentBranch: agentBranch,
    },
    mcpServers,
    // Agent mode adds no rules of its own: allowed_tools alone decides.
    allowedTools: [],
    acceptEdits: false,
    readOnlyGit: false,
  };
}
