import type { GitHubContext } from "../github/context";
import { isEntityContext, isPullRequestEvent } from "../github/context";
import { checkContainsTrigger } from "../github/validation/trigger";

export type AutoDetectedMode = "tag" | "agent";

export function detectMode(context: GitHubContext): AutoDetectedMode {
  if (context.inputs.trackProgress) {
    validateTrackProgressEvent(context);
    return "tag";
  }

  if (!isEntityContext(context)) return "agent";

  if (context.inputs.prompt) return "agent";

  // A mention in a PR body or title alone does not select tag mode.
  if (!isPullRequestEvent(context) && checkContainsTrigger(context)) {
    return "tag";
  }

  return "agent";
}

function validateTrackProgressEvent(context: GitHubContext): void {
  const validEvents = [
    "pull_request",
    "issues",
    "issue_comment",
    "pull_request_review_comment",
    "pull_request_review",
  ];
  if (!validEvents.includes(context.eventName)) {
    throw new Error(
      `track_progress is only supported for events: ${validEvents.join(", ")}. ` +
        `Current event: ${context.eventName}`,
    );
  }

  if (context.eventName === "pull_request" && context.eventAction) {
    const validActions = [
      "opened",
      "synchronize",
      "ready_for_review",
      "reopened",
      "labeled",
    ];
    if (!validActions.includes(context.eventAction)) {
      throw new Error(
        `track_progress for pull_request events is only supported for actions: ` +
          `${validActions.join(", ")}. Current action: ${context.eventAction}`,
      );
    }
  }
}
