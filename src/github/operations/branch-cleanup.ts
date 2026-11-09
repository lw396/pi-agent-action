import type { Octokits } from "../api/client";
import { createBranchLink } from "./comments/common";
import { $ } from "bun";

export async function checkAndCommitOrDeleteBranch(
  octokit: Octokits,
  owner: string,
  repo: string,
  agentBranch: string | undefined,
  baseBranch: string,
  useCommitSigning: boolean,
  restoredConfigPaths: string[] = [],
): Promise<{ shouldDeleteBranch: boolean; branchLink: string }> {
  let branchLink = "";
  let shouldDeleteBranch = false;

  // On pull requests, restoreConfigFromBase replaces .claude/, CLAUDE.md and
  // friends with the base branch's versions and leaves them unstaged so the
  // revert does not reach a commit. Auto-committing with a bare `git add -A`
  // would stage them anyway and push a silent revert of the PR author's own
  // config onto their branch.
  //
  // The exclusion is driven by what was actually restored rather than applied
  // unconditionally: this path also runs for issues, where no restore happens
  // and the agent may legitimately have been asked to edit AGENTS.md,
  // CLAUDE.md or .claude/settings.json. Excluding those there would silently drop the work.
  const pathspecArgs =
    restoredConfigPaths.length > 0
      ? ["--", ".", ...restoredConfigPaths.map((p) => `:(exclude)${p}`)]
      : [];

  if (pathspecArgs.length > 0) {
    console.log(
      `Excluding base-restored config from auto-commit: ${restoredConfigPaths.join(", ")}`,
    );
  }

  if (agentBranch) {
    let branchExistsRemotely = false;
    try {
      await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: agentBranch,
      });
      branchExistsRemotely = true;
    } catch (error: any) {
      if (error.status === 404) {
        console.log(`Branch ${agentBranch} does not exist remotely`);
      } else {
        console.error("Error checking if branch exists:", error);
      }
    }

    if (!branchExistsRemotely) {
      console.log(
        `Branch ${agentBranch} does not exist remotely, no branch link will be added`,
      );
      return { shouldDeleteBranch: false, branchLink: "" };
    }

    try {
      const { data: comparison } =
        await octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${baseBranch}...${agentBranch}`,
        });

      if (comparison.total_commits === 0) {
        if (!useCommitSigning) {
          console.log(
            `Branch ${agentBranch} has no commits from the agent, checking for uncommitted changes...`,
          );

          try {
            // Scoped the same way as the staging below: if the restored config
            // is the only dirty entry there is no real work, and the branch
            // should be treated as empty rather than receiving a pure revert.
            const gitStatus =
              await $`git status --porcelain ${pathspecArgs}`.quiet();
            const hasUncommittedChanges =
              gitStatus.stdout.toString().trim().length > 0;

            if (hasUncommittedChanges) {
              console.log("Found uncommitted changes, committing them...");

              await $`git add -A ${pathspecArgs}`;

              const runId = process.env.GITHUB_RUN_ID || "unknown";
              const commitMessage = `Auto-commit: Save uncommitted changes from pi\n\nRun ID: ${runId}`;
              await $`git commit -m ${commitMessage}`;

              await $`git push origin ${agentBranch}`;

              console.log(
                "✅ Successfully committed and pushed uncommitted changes",
              );

              branchLink = createBranchLink(owner, repo, agentBranch);
            } else {
              console.log(
                "No uncommitted changes found, marking branch for deletion",
              );
              shouldDeleteBranch = true;
            }
          } catch (gitError) {
            console.error("Error checking/committing changes:", gitError);
            branchLink = createBranchLink(owner, repo, agentBranch);
          }
        } else {
          console.log(
            `Branch ${agentBranch} has no commits from the agent, will delete it`,
          );
          shouldDeleteBranch = true;
        }
      } else {
        branchLink = createBranchLink(owner, repo, agentBranch);
      }
    } catch (error) {
      console.error("Error comparing commits on the agent branch:", error);
      branchLink = createBranchLink(owner, repo, agentBranch);
    }
  }

  if (shouldDeleteBranch && agentBranch) {
    try {
      await octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${agentBranch}`,
      });
      console.log(`✅ Deleted empty branch: ${agentBranch}`);
    } catch (deleteError) {
      console.error(`Failed to delete branch ${agentBranch}:`, deleteError);
    }
  }

  return { shouldDeleteBranch, branchLink };
}
