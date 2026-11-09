import { createOctokit } from "./api/client";
import { refreshRemoteToken } from "./operations/git-config";
import {
  appTokenMinter,
  revokeAppToken,
  type GitHubAuthentication,
} from "./token";
import { startTokenBroker } from "./token-broker";
import { GitHubTokenRefresher } from "./token-refresh";

/**
 * Keep every action-owned token consumer current. Capture the OIDC request pair
 * before the Runner removes it from process.env. Revocation of the final token
 * remains a separate always() step in action.yml, including after process crashes.
 */
export function startGitHubTokenLifecycle(auth: GitHubAuthentication) {
  let token = auth.token;
  let octokit = createOctokit(token);
  process.env.GITHUB_TOKEN = token;
  process.env.GH_TOKEN = token;

  const mint = auth.source === "app" ? appTokenMinter() : undefined;
  const refresher = mint
    ? new GitHubTokenRefresher({ token, mint, revoke: revokeAppToken })
    : undefined;
  refresher?.onRefresh(async (nextToken) => {
    token = nextToken;
    octokit = createOctokit(token);
    process.env.GITHUB_TOKEN = token;
    process.env.GH_TOKEN = token;
    await refreshRemoteToken(token);
  });
  const broker = refresher && startTokenBroker(() => refresher.token);
  refresher?.start();

  return {
    source: auth.source,
    get token() {
      return token;
    },
    get octokit() {
      return octokit;
    },
    broker,
    async stop() {
      try {
        broker?.stop();
      } finally {
        await refresher?.stop();
      }
    },
  };
}

export type GitHubTokenLifecycle = ReturnType<typeof startGitHubTokenLifecycle>;
