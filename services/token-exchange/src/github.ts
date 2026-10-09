import type { FetchFn } from "./oidc";

const GITHUB_API_URL = "https://api.github.com";

export type Permissions = Record<string, string>;

export type Installation = {
  id: number;
  permissions: Permissions;
  suspended: boolean;
};

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    route: string,
  ) {
    // Only the route template goes into the message: no tokens, no bodies.
    super(`GitHub API ${method} ${route} failed (${status})`);
    this.name = "GitHubApiError";
  }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;

export function createGitHubClient(fetchFn: FetchFn) {
  async function request(
    method: string,
    route: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "pi-agent-action-token-exchange",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchFn(`${GITHUB_API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok && response.status !== 404) {
      throw new GitHubApiError(response.status, method, route);
    }
    return response;
  }

  return {
    async getRepositoryInstallation(
      appJwt: string,
      repository: string,
    ): Promise<Installation | null> {
      const route = "/repos/{owner}/{repo}/installation";
      const response = await request(
        "GET",
        route,
        `/repos/${repository}/installation`,
        appJwt,
      );
      if (response.status === 404) return null;
      const data = (await response.json()) as {
        id: number;
        permissions?: Permissions;
        suspended_at?: string | null;
      };
      return {
        id: data.id,
        permissions: data.permissions ?? {},
        suspended: Boolean(data.suspended_at),
      };
    },

    async createInstallationToken(
      appJwt: string,
      installationId: number,
      repositoryId: number,
      permissions: Permissions,
    ): Promise<string> {
      const route = "/app/installations/{id}/access_tokens";
      const response = await request(
        "POST",
        route,
        `/app/installations/${installationId}/access_tokens`,
        appJwt,
        { repository_ids: [repositoryId], permissions },
      );
      if (response.status === 404) {
        throw new GitHubApiError(404, "POST", route);
      }
      const data = (await response.json()) as { token?: string };
      if (!data.token) {
        throw new GitHubApiError(response.status, "POST", route);
      }
      return data.token;
    },

    async revokeInstallationToken(token: string): Promise<void> {
      await request(
        "DELETE",
        "/installation/token",
        "/installation/token",
        token,
      );
    },

    async getDefaultBranch(token: string, repository: string): Promise<string> {
      const route = "/repos/{owner}/{repo}";
      const response = await request(
        "GET",
        route,
        `/repos/${repository}`,
        token,
      );
      if (response.status === 404) {
        throw new GitHubApiError(404, "GET", route);
      }
      const data = (await response.json()) as { default_branch: string };
      return data.default_branch;
    },

    // Blob SHA of a file at a ref, or null when the file does not exist there.
    async getFileBlobSha(
      token: string,
      repository: string,
      path: string,
      ref: string,
    ): Promise<string | null> {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const response = await request(
        "GET",
        "/repos/{owner}/{repo}/contents/{path}",
        `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        token,
      );
      if (response.status === 404) return null;
      const data = (await response.json()) as { type?: string; sha?: string };
      return data.type === "file" && data.sha ? data.sha : null;
    },
  };
}
