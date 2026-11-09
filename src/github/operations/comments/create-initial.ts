#!/usr/bin/env bun

import { appendFileSync } from "fs";
import { createJobRunLink, createCommentBody } from "./common";
import {
  isPullRequestReviewCommentEvent,
  isPullRequestEvent,
  type ParsedGitHubContext,
} from "../../context";
import type { Octokit } from "@octokit/rest";
import { APP_BOT_ID } from "../../constants";
import type { TrackingComment } from "./tracking-comment";

export async function createInitialComment(
  octokit: Octokit,
  context: ParsedGitHubContext,
): Promise<TrackingComment> {
  const { owner, repo } = context.repository;

  const jobRunLink = createJobRunLink(owner, repo, context.runId);
  const initialBody = createCommentBody(jobRunLink);

  const record = (comment: TrackingComment) => {
    const githubOutput = process.env.GITHUB_OUTPUT!;
    appendFileSync(githubOutput, `tracking_comment_id=${comment.id}\n`);
    return comment;
  };

  try {
    let response;

    if (
      context.inputs.useStickyComment &&
      context.isPR &&
      isPullRequestEvent(context)
    ) {
      const comments = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: context.entityNumber,
      });
      const existingComment = comments.data.find((comment) => {
        const idMatch = comment.user?.id === APP_BOT_ID;
        const botNameMatch =
          comment.user?.type === "Bot" &&
          comment.user?.login.toLowerCase().includes("pi-agent-action");
        const bodyMatch = comment.body === initialBody;

        return idMatch || botNameMatch || bodyMatch;
      });
      if (existingComment) {
        response = await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: initialBody,
        });
      } else {
        response = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: context.entityNumber,
          body: initialBody,
        });
      }
    } else if (isPullRequestReviewCommentEvent(context)) {
      response = await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: context.entityNumber,
        comment_id: context.payload.comment.id,
        body: initialBody,
      });
      console.log(`✅ Created initial comment with ID: ${response.data.id}`);
      return record({ id: response.data.id, namespace: "review" });
    } else {
      response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: context.entityNumber,
        body: initialBody,
      });
    }

    console.log(`✅ Created initial comment with ID: ${response.data.id}`);
    return record({ id: response.data.id, namespace: "issue" });
  } catch (error) {
    console.error("Error in initial comment:", error);

    // Any failure creating the comment the event asks for leaves an issue
    // comment as the only way to report progress.
    try {
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: context.entityNumber,
        body: initialBody,
      });

      console.log(`✅ Created fallback comment with ID: ${response.data.id}`);
      return record({ id: response.data.id, namespace: "issue" });
    } catch (fallbackError) {
      console.error("Error creating fallback comment:", fallbackError);
      throw fallbackError;
    }
  }
}
