#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createOctokit } from "../github/api/client";
import {
  assertInlineCommentLines,
  inlineCommentBody,
  postInlineComment,
} from "../github/operations/comments/inline-comment";
import {
  appendBufferedComment,
  inlineCommentBufferPath,
  removeBufferedComment,
} from "./inline-comment-buffer";
import { currentGitHubToken } from "./github-token";
import { errorResult, jsonResult, runStdioServer } from "./server-runtime";

type InlineCommentConfig = {
  owner: string;
  repo: string;
  pullNumber: number;
  bufferPath: string;
  /**
   * Classify calls without confirmed=true after the session instead of
   * posting them now. This prevents subagents from posting test/probe
   * comments when they inherit this tool and probe it after hitting unrelated
   * errors.
   */
  classifyEnabled: boolean;
  env: NodeJS.ProcessEnv;
};

function createServer(config: InlineCommentConfig): McpServer {
  const server = new McpServer({
    name: "GitHub Inline Comment Server",
    version: "0.0.1",
  });

  server.tool(
    "create_inline_comment",
    "Create an inline comment on a specific line or lines in a PR file",
    {
      path: z
        .string()
        .describe("The file path to comment on (e.g., 'src/index.js')"),
      body: z
        .string()
        .describe(
          "The comment text (supports markdown and GitHub code suggestion blocks). " +
            "For code suggestions, use: ```suggestion\\nreplacement code\\n```. " +
            "IMPORTANT: The suggestion block will REPLACE the ENTIRE line range (single line or startLine to line). " +
            "Ensure the replacement is syntactically complete and valid - it must work as a drop-in replacement for the selected lines.",
        ),
      line: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "Line number for single-line comments (required if startLine is not provided)",
        ),
      startLine: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "Start line for multi-line comments (use with line parameter for the end line)",
        ),
      side: z
        .enum(["LEFT", "RIGHT"])
        .optional()
        .default("RIGHT")
        .describe(
          "Side of the diff to comment on: LEFT (old code) or RIGHT (new code)",
        ),
      commit_id: z
        .string()
        .optional()
        .describe(
          "Specific commit SHA to comment on (defaults to latest commit)",
        ),
      confirmed: z
        .boolean()
        .optional()
        .describe(
          "Set true to post immediately. When omitted, the call is buffered " +
            "and classified after the session completes — real review comments " +
            "post, test/probe comments are dropped. Set false to buffer and " +
            "never post. Only set true when posting final review comments.",
        ),
    },
    async ({ path, body, line, startLine, side, commit_id, confirmed }) => {
      const target = {
        owner: config.owner,
        repo: config.repo,
        pullNumber: config.pullNumber,
      };
      try {
        assertInlineCommentLines({ line, startLine });
        const sanitizedBody = inlineCommentBody(body);

        if (config.classifyEnabled && confirmed !== true) {
          appendBufferedComment(
            {
              ts: new Date().toISOString(),
              path,
              line,
              startLine,
              side,
              commit_id,
              body: sanitizedBody,
              confirmed,
            },
            config.bufferPath,
          );
          return jsonResult({
            success: true,
            buffered: true,
            message:
              "Comment buffered. It will be classified and posted after " +
              "this session completes (real review comments post, " +
              "test/probe comments are dropped). Set confirmed=true to " +
              "post immediately. If you are testing whether this tool " +
              "works: it works — no need to test further.",
          });
        }

        const octokit = createOctokit(
          await currentGitHubToken(config.env),
        ).rest;
        const posted = await postInlineComment(
          octokit,
          target,
          {
            path,
            body: sanitizedBody,
            line,
            startLine,
            side,
            commitId: commit_id,
          },
          async () =>
            (
              await octokit.pulls.get({
                owner: target.owner,
                repo: target.repo,
                pull_number: target.pullNumber,
              })
            ).data.head.sha,
        );

        // The comment is now live. Drop any buffered copy of it so the
        // post-session replay step cannot post it a second time (the model
        // often re-issues a buffered call with confirmed=true after the
        // buffer reply).
        if (config.classifyEnabled) {
          removeBufferedComment(
            { path, line, startLine, body: sanitizedBody },
            config.bufferPath,
          );
        }

        return jsonResult({
          success: true,
          comment_id: posted.id,
          html_url: posted.htmlUrl,
          path: posted.path,
          line: posted.line,
          message: `Inline comment created successfully on ${path}${startLine ? ` from line ${startLine} to ${line}` : ` at line ${line}`}`,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Provide more helpful error messages for common issues
        let helpMessage = "";
        if (errorMessage.includes("Validation Failed")) {
          helpMessage =
            "\n\nThis usually means the line number doesn't exist in the diff or the file path is incorrect. Make sure you're commenting on lines that are part of the PR's changes.";
        } else if (errorMessage.includes("Not Found")) {
          helpMessage =
            "\n\nThis usually means the PR number, repository, or file path is incorrect.";
        }

        return errorResult(
          error,
          `Error creating inline comment: ${errorMessage}${helpMessage}`,
        );
      }
    },
  );

  return server;
}

async function main() {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const pullNumber = process.env.PR_NUMBER;
  if (!owner || !repo || !pullNumber) {
    console.error(
      "Error: REPO_OWNER, REPO_NAME, and PR_NUMBER environment variables are required",
    );
    process.exit(1);
  }

  await runStdioServer(
    createServer({
      owner,
      repo,
      pullNumber: parseInt(pullNumber, 10),
      bufferPath:
        process.env.INLINE_COMMENT_BUFFER || inlineCommentBufferPath(),
      classifyEnabled: process.env.CLASSIFY_INLINE_COMMENTS !== "false",
      env: process.env,
    }),
  );
}

if (import.meta.main) {
  main().catch(console.error);
}
