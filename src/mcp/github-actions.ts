import type { Octokit } from "@octokit/rest";
import { mkdir, writeFile } from "fs/promises";

export async function getCiStatus(
  client: Octokit,
  params: {
    owner: string;
    repo: string;
    pull_number: number;
    status?: NonNullable<
      Parameters<Octokit["actions"]["listWorkflowRunsForRepo"]>[0]
    >["status"];
  },
) {
  const { owner, repo, pull_number, status } = params;
  const { data: pr } = await client.pulls.get({ owner, repo, pull_number });
  const runs = await client.paginate(client.actions.listWorkflowRunsForRepo, {
    owner,
    repo,
    head_sha: pr.head.sha,
    ...(status && { status }),
  });
  const summary = { total_runs: runs.length, failed: 0, passed: 0, pending: 0 };
  const processedRuns = runs.map((run) => {
    if (run.status === "completed") {
      if (run.conclusion === "success") summary.passed++;
      else if (run.conclusion === "failure") summary.failed++;
    } else {
      summary.pending++;
    }
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      created_at: run.created_at,
    };
  });
  return { summary, runs: processedRuns };
}

export async function getWorkflowRunDetails(
  client: Octokit,
  params: { owner: string; repo: string; run_id: number },
) {
  const jobs = await client.paginate(
    client.actions.listJobsForWorkflowRun,
    params,
  );
  return {
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      html_url: job.html_url,
      failed_steps: (job.steps || [])
        .filter((step) => step.conclusion === "failure")
        .map((step) => ({ name: step.name, number: step.number })),
    })),
  };
}

// Job logs come from GitHub-hosted storage. Bound the request so a stalled
// download cannot keep the MCP call alive indefinitely.
const DOWNLOAD_JOB_LOG_TIMEOUT_MS = 30_000;

export async function downloadJobLog(
  client: Octokit,
  params: { owner: string; repo: string; job_id: number },
  runnerTemp: string,
  timeoutMs: number = DOWNLOAD_JOB_LOG_TIMEOUT_MS,
): Promise<{ path: string; size_bytes: number }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.actions.downloadJobLogsForWorkflowRun({
      ...params,
      request: { signal: controller.signal },
    });
    // SAFETY: GitHub returns log text here; Octokit's generated type models binary data.
    const logsText = response.data as unknown as string;
    const logsDir = `${runnerTemp}/github-ci-logs`;
    await mkdir(logsDir, { recursive: true });
    const path = `${logsDir}/job-${params.job_id}.log`;
    await writeFile(path, logsText, "utf-8");
    return { path, size_bytes: Buffer.byteLength(logsText, "utf-8") };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
