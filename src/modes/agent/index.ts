import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import { setupGitAuth } from "../git-auth";
import { checkHumanActor } from "../../github/validation/actor";
import { isEntityContext } from "../../github/context";
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
  tokenBroker,
  allowedTools,
  untrustedInput,
}: PrepareOptions): Promise<PrepareResult> {
  await checkHumanActor(octokit.rest, context);

  // Unlike tag mode, a run can go on without git credentials.
  await setupGitAuth({
    githubToken,
    context,
    untrustedInput,
    failOnError: false,
  });

  const prompt =
    context.inputs.prompt ||
    `Repository: ${context.repository.owner}/${context.repository.repo}`;

  // Check for branch info from environment variables (useful for auto-fix workflows)
  const agentBranch = process.env.AGENT_BRANCH || undefined;
  const defaultBranch = context.repository.default_branch || "main";
  const baseBranch = context.inputs.baseBranch || defaultBranch;

  const currentBranch =
    agentBranch ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    defaultBranch;

  const mcpServers = await prepareMcpConfig({
    githubToken,
    tokenBroker,
    owner: context.repository.owner,
    repo: context.repository.repo,
    allowedTools: allowedTools.map((rule) => rule.tool),
    trackingComment: undefined,
    pullRequest:
      isEntityContext(context) && context.isPR
        ? {
            number: context.entityNumber,
            classifyInlineComments: context.inputs.classifyInlineComments,
          }
        : undefined,
    fileOps: context.inputs.useCommitSigning
      ? { branch: currentBranch, baseBranch }
      : undefined,
  });

  return {
    prompt,
    trackingComment: undefined,
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
