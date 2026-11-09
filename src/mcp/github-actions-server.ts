#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { GITHUB_API_URL } from "../github/api/config";
import {
  downloadJobLog,
  getCiStatus,
  getWorkflowRunDetails,
} from "./github-actions";
import { errorResult, jsonResult, runStdioServer } from "./server-runtime";

async function main() {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const prNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !prNumber || !token) {
    console.error(
      "[GitHub CI Server] Error: REPO_OWNER, REPO_NAME, PR_NUMBER, and GITHUB_TOKEN environment variables are required",
    );
    process.exit(1);
  }

  const client = new Octokit({ auth: token, baseUrl: GITHUB_API_URL });
  const server = new McpServer({ name: "GitHub CI Server", version: "0.0.1" });
  console.error("[GitHub CI Server] MCP Server instance created");

  server.tool(
    "get_ci_status",
    "Get CI status summary for this PR",
    {
      status: z
        .enum([
          "completed",
          "action_required",
          "cancelled",
          "failure",
          "neutral",
          "skipped",
          "stale",
          "success",
          "timed_out",
          "in_progress",
          "queued",
          "requested",
          "waiting",
          "pending",
        ])
        .optional()
        .describe("Filter workflow runs by status"),
    },
    async ({ status }) => {
      try {
        return jsonResult(
          await getCiStatus(client, {
            owner,
            repo,
            pull_number: parseInt(prNumber, 10),
            status,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.tool(
    "get_workflow_run_details",
    "Get job and step details for a workflow run",
    { run_id: z.number().describe("The workflow run ID") },
    async ({ run_id }) => {
      try {
        return jsonResult(
          await getWorkflowRunDetails(client, { owner, repo, run_id }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.tool(
    "download_job_log",
    "Download job logs to disk",
    { job_id: z.number().describe("The job ID") },
    async ({ job_id }) => {
      try {
        return jsonResult(
          await downloadJobLog(
            client,
            { owner, repo, job_id },
            process.env.RUNNER_TEMP || "/tmp",
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  await runStdioServer(server);
}

if (import.meta.main) {
  main().catch(() => process.exit(1));
}
