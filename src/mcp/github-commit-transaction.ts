import fetch, { type RequestInit, type Response } from "node-fetch";
import { GITHUB_API_URL } from "../github/api/config";
import { type RetryOptions } from "../utils/retry";
import { isBinaryContent } from "./binary-detection";
import { updateGitReference } from "./update-git-reference";

export type GitHubFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text" | "json">>;

/** One entry of the new tree: file content, an existing blob, or a deletion. */
export type CommitTreeEntry =
  | { path: string; mode: string; content: Buffer }
  | { path: string; mode: string; sha: string | null };

export type CommitTreeParams = {
  owner: string;
  repo: string;
  /** The branch the commit goes to, created from the base branch if missing. */
  branch: string;
  baseBranch: string;
  message: string;
  tree: CommitTreeEntry[];
  githubToken: string;
  fetchFn?: GitHubFetch;
  retryOptions?: Omit<RetryOptions, "shouldRetry">;
};

export type CommitTreeResult = {
  commit: {
    sha: string;
    message: string;
    author: string;
    date: string;
  };
  tree: { sha: string };
};

type GitHubRef = { object: { sha: string } };
type GitHubCommit = { tree: { sha: string } };
type GitHubTree = { sha: string };
type GitHubNewCommit = {
  sha: string;
  message: string;
  author: { name: string; date: string };
};

type ApiClient = {
  get(path: string): Promise<Pick<Response, "ok" | "status" | "text" | "json">>;
  post(
    path: string,
    body: unknown,
  ): Promise<Pick<Response, "ok" | "status" | "text" | "json">>;
};

function apiClient(
  fetchFn: GitHubFetch,
  owner: string,
  repo: string,
  githubToken: string,
): ApiClient {
  const request = (path: string, init: RequestInit = {}) =>
    fetchFn(`${GITHUB_API_URL}/repos/${owner}/${repo}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body !== undefined && {
          "Content-Type": "application/json",
        }),
      },
    });
  return {
    get: (path) => request(path),
    post: (path, body) =>
      request(path, { method: "POST", body: JSON.stringify(body) }),
  };
}

/** The response's JSON; a GET failure names what failed and its status. */
async function getJson<T>(
  api: ApiClient,
  path: string,
  failure: string,
): Promise<T> {
  const response = await api.get(path);
  if (!response.ok) {
    throw new Error(`${failure}: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** The response's JSON; a POST failure also carries GitHub's error text. */
async function postJson<T>(
  api: ApiClient,
  path: string,
  body: unknown,
  failure: string,
): Promise<T> {
  const response = await api.post(path, body);
  if (!response.ok) {
    throw new Error(
      `${failure}: ${response.status} - ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function baseBranchSha(
  api: ApiClient,
  baseBranch: string,
): Promise<string> {
  const baseRef = await api.get(`/git/refs/heads/${baseBranch}`);
  if (baseRef.ok) {
    return ((await baseRef.json()) as GitHubRef).object.sha;
  }

  const repository = await getJson<{ default_branch: string }>(
    api,
    "",
    "Failed to get repository info",
  );
  return (
    await getJson<GitHubRef>(
      api,
      `/git/refs/heads/${repository.default_branch}`,
      "Failed to get default branch reference",
    )
  ).object.sha;
}

/** The branch's commit, creating the branch from the base branch if missing. */
async function branchHeadSha(
  api: ApiClient,
  branch: string,
  baseBranch: string,
): Promise<string> {
  const ref = await api.get(`/git/refs/heads/${branch}`);
  if (ref.ok) {
    return ((await ref.json()) as GitHubRef).object.sha;
  }
  if (ref.status !== 404) {
    throw new Error(`Failed to get branch reference: ${ref.status}`);
  }

  const baseSha = await baseBranchSha(api, baseBranch);
  const createRef = await api.post("/git/refs", {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });
  if (!createRef.ok) {
    throw new Error(
      `Failed to create branch: ${createRef.status} - ${await createRef.text()}`,
    );
  }

  console.log(`Successfully created branch ${branch}`);
  return baseSha;
}

async function treeEntries(
  api: ApiClient,
  tree: CommitTreeEntry[],
): Promise<unknown[]> {
  return Promise.all(
    tree.map(async (entry) => {
      if (!("content" in entry)) {
        return {
          path: entry.path,
          mode: entry.mode,
          type: "blob",
          sha: entry.sha,
        };
      }

      if (isBinaryContent(entry.content)) {
        const blob = await postJson<{ sha: string }>(
          api,
          "/git/blobs",
          {
            content: entry.content.toString("base64"),
            encoding: "base64",
          },
          `Failed to create blob for ${entry.path}`,
        );
        return {
          path: entry.path,
          mode: entry.mode,
          type: "blob",
          sha: blob.sha,
        };
      }

      return {
        path: entry.path,
        mode: entry.mode,
        type: "blob",
        content: entry.content.toString("utf-8"),
      };
    }),
  );
}

/**
 * Commit `tree` onto `branch` through the GitHub API: branch and base commit
 * resolution, one new tree, one new commit and a non-force ref update.
 */
export async function commitTree({
  owner,
  repo,
  branch,
  baseBranch,
  message,
  tree,
  githubToken,
  fetchFn = fetch,
  retryOptions,
}: CommitTreeParams): Promise<CommitTreeResult> {
  const api = apiClient(fetchFn, owner, repo, githubToken);

  const baseSha = await branchHeadSha(api, branch, baseBranch);
  const baseCommit = await getJson<GitHubCommit>(
    api,
    `/git/commits/${baseSha}`,
    "Failed to get base commit",
  );

  const newTree = await postJson<GitHubTree>(
    api,
    "/git/trees",
    { base_tree: baseCommit.tree.sha, tree: await treeEntries(api, tree) },
    "Failed to create tree",
  );

  const newCommit = await postJson<GitHubNewCommit>(
    api,
    "/git/commits",
    { message, tree: newTree.sha, parents: [baseSha] },
    "Failed to create commit",
  );

  await updateGitReference({
    owner,
    repo,
    branch,
    sha: newCommit.sha,
    githubToken,
    fetchFn,
    retryOptions,
  });

  return {
    commit: {
      sha: newCommit.sha,
      message: newCommit.message,
      author: newCommit.author.name,
      date: newCommit.author.date,
    },
    tree: { sha: newTree.sha },
  };
}
