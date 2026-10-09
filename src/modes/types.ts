import type { Octokits } from "../github/api/client";
import type { GitHubContext } from "../github/context";
import type { BranchInfo } from "../github/operations/branch";
import type { ModeRunSettings } from "../runner/run-plan";
import type { ToolRule } from "../runner/tool-rules";

export type PrepareOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  /** The allowed_tools input, which decides the action's MCP servers. */
  allowedTools: ToolRule[];
};

export type PrepareResult = ModeRunSettings & {
  /** The prompt the model gets. */
  prompt: string;
  /** The tracking comment, which only tag mode creates. */
  commentId?: number;
  branchInfo: BranchInfo;
};
