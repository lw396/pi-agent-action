import type { GitHubContext } from "../github/context";
import {
  configureGitAuth,
  replaceCheckoutCredentials,
  setupSshSigning,
} from "../github/operations/git-config";

/**
 * How the agent's commits reach GitHub: git with SSH-signed commits
 * (ssh_signing_key), the GitHub API (use_commit_signing), or plain git.
 * SSH signing takes precedence.
 */
export type CommitMethod = "ssh-signed" | "api" | "git";

/**
 * Set git up for the agent's commits, and replace the credential
 * actions/checkout left in git config with the action's own token. A failure
 * to set up SSH signing always throws; a failure to configure the credential
 * throws only with failOnError, and is otherwise logged.
 */
export async function setupGitAuth({
  githubToken,
  context,
  untrustedInput,
  failOnError,
}: {
  githubToken: string;
  context: GitHubContext;
  untrustedInput: boolean;
  failOnError: boolean;
}): Promise<CommitMethod> {
  const { sshSigningKey, useCommitSigning, botName, botId } = context.inputs;
  const method: CommitMethod = sshSigningKey
    ? "ssh-signed"
    : useCommitSigning
      ? "api"
      : "git";

  if (method === "ssh-signed") {
    await setupSshSigning(sshSigningKey);
  }
  try {
    if (method === "api") {
      // Commits go through the GitHub API, so no git user is needed.
      await replaceCheckoutCredentials(githubToken, context, untrustedInput);
    } else {
      // Pushes still go through git, as the bot user.
      const user = { login: botName, id: parseInt(botId) };
      await configureGitAuth(githubToken, context, user, untrustedInput);
    }
  } catch (error) {
    console.error("Failed to configure git authentication:", error);
    if (failOnError) throw error;
    // Git operations may still work with the default config.
  }
  return method;
}
