#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, stat } from "fs/promises";
import { resolve } from "path";
import { constants } from "fs";
import { validatePathWithinRepo } from "./path-validation";
import { currentGitHubToken } from "./github-token";
import { commitTree, type CommitTreeEntry } from "./github-commit-transaction";
import { errorResult, jsonResult, runStdioServer } from "./server-runtime";
import {
  commitFilesInputSchema,
  deleteFilesInputSchema,
} from "./github-file-ops-schemas";

type FileOpsConfig = {
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  repoDir: string;
  env: NodeJS.ProcessEnv;
};

/**
 * The git mode for `filePath`, from its permission bits. `stat` follows
 * symlinks, so a link commits as its target.
 */
async function gitFileMode(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      return "040000";
    }
    return fileStat.mode & constants.S_IXUSR ? "100755" : "100644";
  } catch (error) {
    console.warn(
      `Could not determine file mode for ${filePath}, using default: ${error}`,
    );
    return "100644";
  }
}

/**
 * The repo-relative paths of `filePaths`. Validation rejects path traversal
 * ("../") and symlinked escapes.
 */
async function repoPaths(
  repoDir: string,
  filePaths: string[],
): Promise<Array<{ fullPath: string; relativePath: string }>> {
  const resolvedRepoDir = resolve(repoDir);
  return Promise.all(
    filePaths.map(async (filePath) => {
      const fullPath = await validatePathWithinRepo(filePath, repoDir);
      return {
        fullPath,
        relativePath: resolve(resolvedRepoDir, filePath).slice(
          resolvedRepoDir.length + 1,
        ),
      };
    }),
  );
}

function createServer(config: FileOpsConfig): McpServer {
  const server = new McpServer({
    name: "GitHub File Operations Server",
    version: "0.0.1",
  });

  server.tool(
    "commit_files",
    "Commit one or more files to a repository in a single commit (this will commit them atomically in the remote repository)",
    commitFilesInputSchema,
    async ({ files, message }) => {
      try {
        const githubToken = await currentGitHubToken(config.env);
        const paths = await repoPaths(config.repoDir, files);
        const tree: CommitTreeEntry[] = await Promise.all(
          paths.map(async ({ fullPath, relativePath }) => ({
            path: relativePath,
            mode: await gitFileMode(fullPath),
            content: await readFile(fullPath),
          })),
        );

        const { commit, tree: newTree } = await commitTree({
          owner: config.owner,
          repo: config.repo,
          branch: config.branch,
          baseBranch: config.baseBranch,
          message,
          tree,
          githubToken,
        });

        return jsonResult({
          commit,
          files: paths.map(({ relativePath }) => ({ path: relativePath })),
          tree: newTree,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "delete_files",
    "Delete one or more files from a repository in a single commit",
    deleteFilesInputSchema,
    async ({ paths: deletedFiles, message }) => {
      try {
        const githubToken = await currentGitHubToken(config.env);
        const paths = await repoPaths(config.repoDir, deletedFiles);
        const tree: CommitTreeEntry[] = paths.map(({ relativePath }) => ({
          path: relativePath,
          mode: "100644",
          sha: null,
        }));

        const { commit, tree: newTree } = await commitTree({
          owner: config.owner,
          repo: config.repo,
          branch: config.branch,
          baseBranch: config.baseBranch,
          message,
          tree,
          githubToken,
        });

        return jsonResult({
          commit,
          deletedFiles: paths.map(({ relativePath }) => ({
            path: relativePath,
          })),
          tree: newTree,
        });
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
  const branch = process.env.BRANCH_NAME;
  const baseBranch = process.env.BASE_BRANCH;
  if (!owner || !repo || !branch || !baseBranch) {
    console.error(
      "Error: REPO_OWNER, REPO_NAME, BRANCH_NAME, and BASE_BRANCH environment variables are required",
    );
    process.exit(1);
  }

  await runStdioServer(
    createServer({
      owner,
      repo,
      branch,
      baseBranch,
      repoDir: process.env.REPO_DIR || process.cwd(),
      env: process.env,
    }),
  );
}

if (import.meta.main) {
  main().catch(console.error);
}
