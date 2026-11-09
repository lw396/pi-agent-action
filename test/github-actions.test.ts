import { describe, test, expect, afterEach } from "bun:test";
import { readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import {
  downloadJobLog,
  getCiStatus,
  getWorkflowRunDetails,
} from "../src/mcp/github-actions";
import type { Octokit } from "@octokit/rest";

test("CI status paginates the PR head's runs, preserves filters and counts outcomes", async () => {
  const pages = [
    [
      { id: 1, status: "completed", conclusion: "success" },
      { id: 2, status: "queued", conclusion: null },
    ],
    [
      { id: 3, status: "completed", conclusion: "failure" },
      { id: 4, status: "in_progress", conclusion: null },
      { id: 5, status: "completed", conclusion: "skipped" },
    ],
  ];
  const route = () => {
    throw new Error("must paginate, not read one page");
  };
  const client = {
    pulls: {
      get: async (params: unknown) => {
        expect(params).toEqual({
          owner: "owner",
          repo: "repo",
          pull_number: 7,
        });
        return { data: { head: { sha: "pr-head" } } };
      },
    },
    actions: { listWorkflowRunsForRepo: route },
    paginate: async (method: unknown, params: unknown) => {
      expect(method).toBe(route);
      expect(params).toEqual({
        owner: "owner",
        repo: "repo",
        head_sha: "pr-head",
        status: "completed",
      });
      return pages.flat();
    },
  } as unknown as Octokit;
  const result = await getCiStatus(client, {
    owner: "owner",
    repo: "repo",
    pull_number: 7,
    status: "completed",
  });
  expect(result.summary).toEqual({
    total_runs: 5,
    failed: 1,
    passed: 1,
    pending: 2,
  });
  expect(result.runs.map((run) => run.id)).toEqual([1, 2, 3, 4, 5]);
});

test("run details paginate the requested run and report only failed steps", async () => {
  const route = () => {
    throw new Error("must paginate, not read one page");
  };
  const client = {
    actions: { listJobsForWorkflowRun: route },
    paginate: async (method: unknown, params: unknown) => {
      expect(method).toBe(route);
      expect(params).toEqual({ owner: "owner", repo: "repo", run_id: 42 });
      return [
        {
          id: 1,
          name: "build",
          conclusion: "failure",
          html_url: "https://example.test/job/1",
          steps: [
            { name: "install", number: 1, conclusion: "success" },
            { name: "compile", number: 2, conclusion: "failure" },
          ],
        },
        {
          id: 2,
          name: "test",
          conclusion: "success",
          html_url: "https://example.test/job/2",
        },
      ];
    },
  } as unknown as Octokit;
  expect(
    await getWorkflowRunDetails(client, {
      owner: "owner",
      repo: "repo",
      run_id: 42,
    }),
  ).toEqual({
    jobs: [
      {
        id: 1,
        name: "build",
        conclusion: "failure",
        html_url: "https://example.test/job/1",
        failed_steps: [{ name: "compile", number: 2 }],
      },
      {
        id: 2,
        name: "test",
        conclusion: "success",
        html_url: "https://example.test/job/2",
        failed_steps: [],
      },
    ],
  });
});

describe("downloadJobLog", () => {
  const tmpDirs: string[] = [];

  const makeRunnerTemp = () => {
    const dir = path.join(
      os.tmpdir(),
      `download-job-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    tmpDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  const createStallingClient = (): {
    client: Octokit;
    getSignal: () => AbortSignal | undefined;
  } => {
    let signal: AbortSignal | undefined;
    const client = {
      actions: {
        downloadJobLogsForWorkflowRun: (params: {
          request?: { signal?: AbortSignal };
        }) => {
          signal = params.request?.signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new Error("This operation was aborted"));
            });
            // Otherwise never settles, simulating a stalled fetch.
          });
        },
      },
    } as unknown as Octokit;
    return { client, getSignal: () => signal };
  };

  test("rejects with a timeout instead of hanging when the download stalls", async () => {
    const { client, getSignal } = createStallingClient();
    const runnerTemp = makeRunnerTemp();

    await expect(
      downloadJobLog(
        client,
        { owner: "owner", repo: "repo", job_id: 123 },
        runnerTemp,
        5,
      ),
    ).rejects.toThrow();

    expect(getSignal()?.aborted).toBe(true);
  });

  test("writes the log to disk and clears the timeout when the download succeeds", async () => {
    const runnerTemp = makeRunnerTemp();
    const client = {
      actions: {
        downloadJobLogsForWorkflowRun: async (params: {
          request?: { signal?: AbortSignal };
        }) => {
          expect(params.request?.signal?.aborted).toBe(false);
          return { data: "log line 1\nlog line 2\n" };
        },
      },
    } as unknown as Octokit;

    const result = await downloadJobLog(
      client,
      { owner: "owner", repo: "repo", job_id: 456 },
      runnerTemp,
      30_000,
    );

    expect(result.path).toBe(`${runnerTemp}/github-ci-logs/job-456.log`);
    expect(result.size_bytes).toBe(
      Buffer.byteLength("log line 1\nlog line 2\n", "utf-8"),
    );

    const written = await readFile(result.path, "utf-8");
    expect(written).toBe("log line 1\nlog line 2\n");
  });
});
