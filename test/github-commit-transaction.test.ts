// The signed-commit transaction the file ops server runs: one commit per call
// through the Git data API, against a fake GitHub that records the requests.
import { describe, expect, test } from "bun:test";
import { GITHUB_API_URL } from "../src/github/api/config";
import {
  commitTree,
  type CommitTreeEntry,
} from "../src/mcp/github-commit-transaction";

const repoUrl = `${GITHUB_API_URL}/repos/owner/repo`;
const refUrl = `${repoUrl}/git/refs/heads/feature`;
const baseRefUrl = `${repoUrl}/git/refs/heads/main`;
const repoInfoUrl = repoUrl;
const defaultRefUrl = `${repoUrl}/git/refs/heads/trunk`;

type Reply = { status: number; body?: unknown };
type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

function response({ status, body }: Reply) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body ?? {}),
    json: async () => body,
  };
}

function gitHub(replies: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    calls.push({
      method,
      url,
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request: ${key}`);
    return response(reply);
  };
  return { calls, fetchFn };
}

const textFile: CommitTreeEntry = {
  path: "src/a.ts",
  mode: "100644",
  content: Buffer.from("export const a = 1;\n"),
};

const existingReplies: Record<string, Reply> = {
  [`GET ${refUrl}`]: { status: 200, body: { object: { sha: "base-sha" } } },
  [`GET ${repoUrl}/git/commits/base-sha`]: {
    status: 200,
    body: { tree: { sha: "base-tree" } },
  },
  [`POST ${repoUrl}/git/trees`]: { status: 201, body: { sha: "new-tree" } },
  [`POST ${repoUrl}/git/commits`]: {
    status: 201,
    body: {
      sha: "new-commit",
      message: "Add a",
      author: { name: "pi", date: "2026-01-01T00:00:00Z" },
    },
  },
  [`PATCH ${refUrl}`]: { status: 200 },
};

function commit(overrides: Partial<Parameters<typeof commitTree>[0]> = {}) {
  const { calls, fetchFn } = gitHub(existingReplies);
  const result = commitTree({
    owner: "owner",
    repo: "repo",
    branch: "feature",
    baseBranch: "main",
    message: "Add a",
    tree: [textFile],
    githubToken: "token",
    fetchFn,
    ...overrides,
  });
  return { calls, result };
}

describe("commitTree", () => {
  test("commits the tree, then updates the branch ref without forcing it", async () => {
    const { calls, result } = commit();

    expect(await result).toEqual({
      commit: {
        sha: "new-commit",
        message: "Add a",
        author: "pi",
        date: "2026-01-01T00:00:00Z",
      },
      tree: { sha: "new-tree" },
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${refUrl}`,
      `GET ${repoUrl}/git/commits/base-sha`,
      `POST ${repoUrl}/git/trees`,
      `POST ${repoUrl}/git/commits`,
      `PATCH ${refUrl}`,
    ]);

    for (const call of calls) {
      expect(call.headers.Authorization).toBe("Bearer token");
      expect(call.headers.Accept).toBe("application/vnd.github+json");
      expect(call.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    }

    expect(calls[2]!.body).toEqual({
      base_tree: "base-tree",
      tree: [
        {
          path: "src/a.ts",
          mode: "100644",
          type: "blob",
          content: "export const a = 1;\n",
        },
      ],
    });
    expect(calls[3]!.body).toEqual({
      message: "Add a",
      tree: "new-tree",
      parents: ["base-sha"],
    });
    expect(calls[4]!.body).toEqual({ sha: "new-commit", force: false });
  });

  test("deletes a path by sending a null blob in the tree", async () => {
    const { calls, result } = commit({
      tree: [{ path: "src/old.ts", mode: "100644", sha: null }],
    });

    await result;

    expect(calls[2]!.body).toEqual({
      base_tree: "base-tree",
      tree: [{ path: "src/old.ts", mode: "100644", type: "blob", sha: null }],
    });
  });

  test("uploads binary content as a base64 blob before the tree", async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff]);
    const replies = {
      ...existingReplies,
      [`POST ${repoUrl}/git/blobs`]: {
        status: 201,
        body: { sha: "blob-sha" },
      },
    };
    const { calls, fetchFn } = gitHub(replies);

    await commitTree({
      owner: "owner",
      repo: "repo",
      branch: "feature",
      baseBranch: "main",
      message: "Add image",
      tree: [{ path: "assets/logo.png", mode: "100644", content: binary }],
      githubToken: "token",
      fetchFn,
    });

    const blob = calls.find((c) => c.url === `${repoUrl}/git/blobs`)!;
    expect(blob.body).toEqual({
      content: binary.toString("base64"),
      encoding: "base64",
    });
    expect(calls[3]!.body).toEqual({
      base_tree: "base-tree",
      tree: [
        {
          path: "assets/logo.png",
          mode: "100644",
          type: "blob",
          sha: "blob-sha",
        },
      ],
    });
  });

  test("creates the branch from the base branch when it is missing", async () => {
    const { calls, fetchFn } = gitHub({
      ...existingReplies,
      [`GET ${refUrl}`]: { status: 404 },
      [`GET ${baseRefUrl}`]: {
        status: 200,
        body: { object: { sha: "base-sha" } },
      },
      [`POST ${repoUrl}/git/refs`]: { status: 201 },
    });

    await commitTree({
      owner: "owner",
      repo: "repo",
      branch: "feature",
      baseBranch: "main",
      message: "Add a",
      tree: [textFile],
      githubToken: "token",
      fetchFn,
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${refUrl}`,
      `GET ${baseRefUrl}`,
      `POST ${repoUrl}/git/refs`,
      `GET ${repoUrl}/git/commits/base-sha`,
      `POST ${repoUrl}/git/trees`,
      `POST ${repoUrl}/git/commits`,
      `PATCH ${refUrl}`,
    ]);
    expect(calls[2]!.body).toEqual({
      ref: "refs/heads/feature",
      sha: "base-sha",
    });
  });

  test("creates the branch from the default branch when the base branch is missing", async () => {
    const { calls, fetchFn } = gitHub({
      ...existingReplies,
      [`GET ${refUrl}`]: { status: 404 },
      [`GET ${baseRefUrl}`]: { status: 404 },
      [`GET ${repoInfoUrl}`]: {
        status: 200,
        body: { default_branch: "trunk" },
      },
      [`GET ${defaultRefUrl}`]: {
        status: 200,
        body: { object: { sha: "base-sha" } },
      },
      [`POST ${repoUrl}/git/refs`]: { status: 201 },
    });

    await commitTree({
      owner: "owner",
      repo: "repo",
      branch: "feature",
      baseBranch: "main",
      message: "Add a",
      tree: [textFile],
      githubToken: "token",
      fetchFn,
    });

    expect(calls.slice(0, 3).map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${refUrl}`,
      `GET ${baseRefUrl}`,
      `GET ${repoInfoUrl}`,
    ]);
    expect(calls[3]!.url).toBe(defaultRefUrl);
    expect(calls[4]!.body).toEqual({
      ref: "refs/heads/feature",
      sha: "base-sha",
    });
  });

  test("names the request that failed", async () => {
    const failures: Array<[Record<string, Reply>, string]> = [
      [
        { [`GET ${refUrl}`]: { status: 500 } },
        "Failed to get branch reference: 500",
      ],
      [
        {
          [`GET ${refUrl}`]: { status: 200, body: { object: { sha: "base" } } },
          [`GET ${repoUrl}/git/commits/base`]: { status: 404 },
        },
        "Failed to get base commit: 404",
      ],
      [
        {
          ...existingReplies,
          [`POST ${repoUrl}/git/trees`]: {
            status: 422,
            body: "invalid tree",
          },
        },
        "Failed to create tree: 422 -",
      ],
      [
        {
          ...existingReplies,
          [`POST ${repoUrl}/git/commits`]: { status: 500, body: "boom" },
        },
        "Failed to create commit: 500 - boom",
      ],
      [
        {
          ...existingReplies,
          [`GET ${refUrl}`]: { status: 404 },
          [`GET ${baseRefUrl}`]: {
            status: 200,
            body: { object: { sha: "base-sha" } },
          },
          [`POST ${repoUrl}/git/refs`]: { status: 422, body: "exists" },
        },
        "Failed to create branch: 422 - exists",
      ],
    ];

    for (const [replies, message] of failures) {
      const { fetchFn } = gitHub(replies);
      await expect(
        commitTree({
          owner: "owner",
          repo: "repo",
          branch: "feature",
          baseBranch: "main",
          message: "Add a",
          tree: [textFile],
          githubToken: "token",
          fetchFn,
        }),
      ).rejects.toThrow(message);
    }
  });

  test("does not retry a ref update GitHub rejects", async () => {
    const { calls, fetchFn } = gitHub({
      ...existingReplies,
      [`PATCH ${refUrl}`]: {
        status: 422,
        body: "Update is not a fast forward",
      },
    });

    await expect(
      commitTree({
        owner: "owner",
        repo: "repo",
        branch: "feature",
        baseBranch: "main",
        message: "Add a",
        tree: [textFile],
        githubToken: "token",
        fetchFn,
        retryOptions: { initialDelayMs: 1 },
      }),
    ).rejects.toThrow("Failed to update reference: 422");

    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});
