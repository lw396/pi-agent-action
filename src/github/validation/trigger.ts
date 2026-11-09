#!/usr/bin/env bun

import {
  isIssuesEvent,
  isIssuesAssignedEvent,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../context";
import type { ParsedGitHubContext } from "../context";

export function checkContainsTrigger(context: ParsedGitHubContext): boolean {
  const {
    inputs: { assigneeTrigger, labelTrigger, triggerPhrase, prompt },
  } = context;

  if (prompt) {
    console.log(`Prompt provided, triggering action`);
    return true;
  }

  if (isIssuesAssignedEvent(context)) {
    // Remove @ symbol from assignee_trigger if present
    const triggerUser = assigneeTrigger.replace(/^@/, "");
    const assigneeUsername = context.payload.assignee?.login || "";

    if (triggerUser && assigneeUsername === triggerUser) {
      console.log(`Issue assigned to trigger user '${triggerUser}'`);
      return true;
    }
  }

  if (isIssuesEvent(context) && context.eventAction === "labeled") {
    const labelName = (context.payload as any).label?.name || "";

    if (
      labelTrigger &&
      labelName.toLowerCase() === labelTrigger.toLowerCase()
    ) {
      console.log(`Issue labeled with trigger label '${labelTrigger}'`);
      return true;
    }
  }

  // Exact match with word boundaries or punctuation.
  const mention = new RegExp(
    `(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`,
    "i",
  );

  if (isIssuesEvent(context) && context.eventAction === "opened") {
    const issueBody = context.payload.issue.body || "";
    const issueTitle = context.payload.issue.title || "";

    if (mention.test(issueBody)) {
      console.log(
        `Issue body contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }

    if (mention.test(issueTitle)) {
      console.log(
        `Issue title contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  if (isPullRequestEvent(context)) {
    const prBody = context.payload.pull_request.body || "";
    const prTitle = context.payload.pull_request.title || "";

    if (mention.test(prBody)) {
      console.log(
        `Pull request body contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }

    if (mention.test(prTitle)) {
      console.log(
        `Pull request title contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  if (
    isPullRequestReviewEvent(context) &&
    (context.eventAction === "submitted" || context.eventAction === "edited")
  ) {
    const reviewBody = context.payload.review.body || "";
    if (mention.test(reviewBody)) {
      console.log(
        `Pull request review contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  if (
    isIssueCommentEvent(context) ||
    isPullRequestReviewCommentEvent(context)
  ) {
    if (mention.test(context.payload.comment.body)) {
      console.log(`Comment contains exact trigger phrase '${triggerPhrase}'`);
      return true;
    }
  }

  console.log(`No trigger was met for ${triggerPhrase}`);

  return false;
}

export function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
