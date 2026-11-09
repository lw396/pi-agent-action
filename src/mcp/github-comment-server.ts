#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GITHUB_API_URL } from "../github/api/config";
import { Octokit } from "@octokit/rest";
import { updateComment } from "../github/operations/comments/update-comment";
import type { TrackingComment } from "../github/operations/comments/tracking-comment";
import { redactSecrets, sanitizeContent } from "../security/sanitizer";
import { currentGitHubToken } from "./github-token";
import { errorResult, jsonResult, runStdioServer } from "./server-runtime";

type CommentServerConfig = {
  owner: string;
  repo: string;
  env: NodeJS.ProcessEnv;
};

function trackingCommentFrom(env: NodeJS.ProcessEnv): TrackingComment {
  const id = env.TRACKING_COMMENT_ID;
  if (!id) {
    throw new Error("TRACKING_COMMENT_ID environment variable is required");
  }
  const namespace = env.TRACKING_COMMENT_NAMESPACE;
  if (namespace !== "issue" && namespace !== "review") {
    throw new Error(
      'TRACKING_COMMENT_NAMESPACE environment variable must be "issue" or "review"',
    );
  }
  return { id: parseInt(id, 10), namespace };
}

function createServer(config: CommentServerConfig): McpServer {
  const server = new McpServer({
    name: "GitHub Comment Server",
    version: "0.0.1",
  });

  server.tool(
    "update_comment",
    "Update the tracking comment with progress and results (automatically handles both issue and PR comments)",
    {
      body: z.string().describe("The updated comment content"),
    },
    async ({ body }) => {
      try {
        const githubToken = await currentGitHubToken(config.env);
        const octokit = new Octokit({
          auth: githubToken,
          baseUrl: GITHUB_API_URL,
        });

        const result = await updateComment(octokit, {
          owner: config.owner,
          repo: config.repo,
          comment: trackingCommentFrom(config.env),
          body: redactSecrets(sanitizeContent(body)),
        });

        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

async function main() {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  if (!owner || !repo) {
    console.error(
      "Error: REPO_OWNER and REPO_NAME environment variables are required",
    );
    process.exit(1);
  }
  await runStdioServer(createServer({ owner, repo, env: process.env }));
}

if (import.meta.main) {
  main().catch(console.error);
}
