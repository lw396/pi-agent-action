import * as core from "@actions/core";
import { GITHUB_API_URL, GITHUB_SERVER_URL } from "../github/api/config";
import { redactSecrets } from "../security/sanitizer";
import { Octokit } from "@octokit/rest";
import type { McpServers } from "../runner/mcp-servers";
import type { TokenBrokerAddress } from "../github/token-broker";
import type { TrackingComment } from "../github/operations/comments/tracking-comment";
import { inlineCommentBufferPath } from "./inline-comment-buffer";

type PrepareConfigParams = {
  githubToken: string;
  /**
   * Where the servers get the current app token instead of githubToken, so
   * they keep working after it is refreshed (src/github/token-refresh.ts).
   */
  tokenBroker?: TokenBrokerAddress;
  owner: string;
  repo: string;
  /** The workflow's tool grants, plus the mode's own grants. */
  allowedTools: string[];
  /** The tracking comment the comment server updates, if the run has one. */
  trackingComment?: TrackingComment;
  /** The PR whose inline comments and CI status the servers read. */
  pullRequest?: { number: number; classifyInlineComments: boolean };
  /**
   * use_commit_signing: the file ops server commits through the API to this
   * branch, and creates it from the base branch when it is missing.
   */
  fileOps?: { branch: string; baseBranch: string };
  /** The environment the servers' configuration is read from. */
  env?: NodeJS.ProcessEnv;
};

// Build the bun invocation for one of the action's own MCP servers. The
// flags mirror the entrypoint invocation in action.yml so the server process
// reads its runtime config from the action directory rather than from the
// process working directory.
function bunServerArgs(env: NodeJS.ProcessEnv, scriptPath: string): string[] {
  const actionPath = env.GITHUB_ACTION_PATH;
  return [
    "--no-env-file",
    `--config=${actionPath}/bunfig.toml`,
    "run",
    `${actionPath}/${scriptPath}`,
  ];
}

function usesServer(allowedTools: string[], server: string): boolean {
  return allowedTools.some(
    (tool) => tool === `mcp__${server}` || tool.startsWith(`mcp__${server}__`),
  );
}

async function checkActionsReadPermission(
  token: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const client = new Octokit({ auth: token, baseUrl: GITHUB_API_URL });

    await client.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 1,
    });

    return true;
  } catch (error: any) {
    if (
      error.status === 403 &&
      error.message?.includes("Resource not accessible")
    ) {
      return false;
    }

    // For other errors (network issues, etc), log but don't fail
    core.debug(`Failed to check actions permission: ${error.message}`);
    return false;
  }
}

/**
 * The env that gives a server the GitHub token: the broker's address when
 * there is one, so each call asks the action for the current token instead of
 * keeping the token the server started with. pi starts these servers with
 * this process's environment, so the token is there either way.
 */
function githubTokenEnv(
  githubToken: string,
  tokenBroker: TokenBrokerAddress | undefined,
): Record<string, string> {
  return tokenBroker
    ? {
        GITHUB_TOKEN_BROKER_URL: tokenBroker.url,
        GITHUB_TOKEN_BROKER_KEY: tokenBroker.key,
      }
    : { GITHUB_TOKEN: githubToken };
}

/** The action's own MCP servers, by name, that the run needs. */
export async function prepareMcpConfig(
  params: PrepareConfigParams,
): Promise<McpServers> {
  const {
    githubToken,
    tokenBroker,
    owner,
    repo,
    allowedTools,
    trackingComment,
    pullRequest,
    fileOps,
    env = process.env,
  } = params;
  try {
    const hasGitHubCommentTools = usesServer(allowedTools, "github_comment");
    const hasGitHubMcpTools = usesServer(allowedTools, "github");
    const hasInlineCommentTools = usesServer(
      allowedTools,
      "github_inline_comment",
    );
    const hasGitHubCITools = usesServer(allowedTools, "github_ci");

    const servers: McpServers = {};

    if (hasGitHubCommentTools) {
      servers.github_comment = {
        command: "bun",
        args: bunServerArgs(env, "src/mcp/github-comment-server.ts"),
        env: {
          ...githubTokenEnv(githubToken, tokenBroker),
          REPO_OWNER: owner,
          REPO_NAME: repo,
          ...(trackingComment && {
            TRACKING_COMMENT_ID: trackingComment.id.toString(),
            TRACKING_COMMENT_NAMESPACE: trackingComment.namespace,
          }),
          GITHUB_API_URL: GITHUB_API_URL,
        },
      };
    }

    if (fileOps) {
      servers.github_file_ops = {
        command: "bun",
        args: bunServerArgs(env, "src/mcp/github-file-ops-server.ts"),
        env: {
          ...githubTokenEnv(githubToken, tokenBroker),
          REPO_OWNER: owner,
          REPO_NAME: repo,
          BRANCH_NAME: fileOps.branch,
          BASE_BRANCH: fileOps.baseBranch,
          REPO_DIR: env.GITHUB_WORKSPACE || process.cwd(),
          GITHUB_API_URL: GITHUB_API_URL,
        },
      };
    }

    if (pullRequest && (hasGitHubMcpTools || hasInlineCommentTools)) {
      servers.github_inline_comment = {
        command: "bun",
        args: bunServerArgs(env, "src/mcp/github-inline-comment-server.ts"),
        env: {
          ...githubTokenEnv(githubToken, tokenBroker),
          REPO_OWNER: owner,
          REPO_NAME: repo,
          PR_NUMBER: pullRequest.number.toString(),
          GITHUB_API_URL: GITHUB_API_URL,
          CLASSIFY_INLINE_COMMENTS: pullRequest.classifyInlineComments
            ? "true"
            : "false",
          INLINE_COMMENT_BUFFER: inlineCommentBufferPath(env),
        },
      };
    }

    const workflowToken = env.DEFAULT_WORKFLOW_TOKEN;
    if (hasGitHubCITools && pullRequest && workflowToken) {
      const actuallyHasPermission = await checkActionsReadPermission(
        workflowToken,
        owner,
        repo,
      );

      if (!actuallyHasPermission) {
        core.warning(
          "The github_ci MCP server requires 'actions: read' permission. " +
            "Skipping CI server installation. " +
            "To enable CI status checks, add 'actions: read' to your workflow permissions. " +
            "See: https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token",
        );
      } else {
        servers.github_ci = {
          command: "bun",
          args: bunServerArgs(env, "src/mcp/github-actions-server.ts"),
          env: {
            // The workflow token, not the action's app token.
            GITHUB_TOKEN: workflowToken,
            REPO_OWNER: owner,
            REPO_NAME: repo,
            PR_NUMBER: pullRequest.number.toString(),
            RUNNER_TEMP: env.RUNNER_TEMP || "/tmp",
          },
        };
      }
    }

    if (hasGitHubMcpTools) {
      servers.github = {
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "-e",
          "GITHUB_HOST",
          "ghcr.io/github/github-mcp-server:sha-23fa0dd", // https://github.com/github/github-mcp-server/releases/tag/v0.17.1
        ],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
          GITHUB_HOST: GITHUB_SERVER_URL,
        },
      };
    }

    return servers;
  } catch (error) {
    throw new Error(
      `Install MCP server failed with error: ${redactSecrets(String(error))}`,
    );
  }
}
