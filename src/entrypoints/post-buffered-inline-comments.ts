#!/usr/bin/env bun
/**
 * Reads buffered inline-comment calls from /tmp/inline-comments-buffer.jsonl,
 * classifies each as "real review" vs "test/probe" through pi
 * (src/runner/classify-comments.ts), and posts only the real ones. Calls with
 * confirmed=false are never posted.
 *
 * When classification is not possible (no model, no credentials, a failed
 * request), falls back to posting everything with confirmed !== false, as
 * Upstream does without an Anthropic key.
 */
import { readFileSync } from "fs";
import { createOctokit } from "../github/api/client";
import { redactSecrets } from "../github/utils/sanitizer";
import { collectSecretValues } from "../github/utils/secret-values";
import { classifyComments } from "../runner/classify-comments";

const BUFFER_PATH = "/tmp/inline-comments-buffer.jsonl";

type BufferedComment = {
  ts: string;
  path: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
  body: string;
  confirmed?: boolean;
};

async function postComment(
  octokit: ReturnType<typeof createOctokit>["rest"],
  owner: string,
  repo: string,
  pull_number: number,
  headSha: string,
  c: BufferedComment,
): Promise<boolean> {
  const params: Parameters<typeof octokit.rest.pulls.createReviewComment>[0] = {
    owner,
    repo,
    pull_number,
    body: redactSecrets(c.body),
    path: c.path,
    side: c.side || "RIGHT",
    commit_id: c.commit_id || headSha,
  };
  if (c.startLine) {
    params.start_line = c.startLine;
    params.start_side = c.side || "RIGHT";
    params.line = c.line;
  } else {
    params.line = c.line;
  }
  try {
    await octokit.rest.pulls.createReviewComment(params);
    return true;
  } catch (e) {
    console.log(
      `  failed ${c.path}:${c.line}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

async function main() {
  collectSecretValues(process.env);
  let raw: string;
  try {
    raw = readFileSync(BUFFER_PATH, "utf8");
  } catch {
    console.log("No buffered inline comments");
    return;
  }

  const comments: BufferedComment[] = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (comments.length === 0) {
    console.log("No buffered inline comments");
    return;
  }

  console.log(`Found ${comments.length} buffered inline comment(s)`);

  const githubToken = process.env.GITHUB_TOKEN;
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const prNumber = process.env.PR_NUMBER;

  if (!githubToken || !owner || !repo || !prNumber) {
    console.log(
      "::warning::Missing GITHUB_TOKEN/REPO_OWNER/REPO_NAME/PR_NUMBER — cannot post buffered comments",
    );
    return;
  }

  // Partition: confirmed=false are never posted; the rest are candidates
  const neverPost = comments.filter((c) => c.confirmed === false);
  const candidates = comments.filter((c) => c.confirmed !== false);

  if (neverPost.length > 0) {
    console.log(`  ${neverPost.length} with confirmed=false — not posting`);
  }

  if (candidates.length === 0) {
    return;
  }

  // Classify candidates
  const verdicts = await classifyComments(
    candidates.map((c) => c.body),
    {
      model: process.env.MODEL,
      classifyModel: process.env.CLASSIFY_MODEL,
      apiKey: process.env.API_KEY,
    },
  );
  const toPost =
    verdicts === null
      ? candidates
      : candidates.filter((_, i) => verdicts[i] === true);
  const filtered =
    verdicts === null ? [] : candidates.filter((_, i) => verdicts[i] === false);

  if (filtered.length > 0) {
    console.log(
      `::warning::${filtered.length} buffered comment(s) classified as test/probe — NOT posted:`,
    );
    for (const c of filtered) {
      console.log(`  [${c.path}:${c.line}] ${c.body.slice(0, 120)}`);
    }
  }

  if (toPost.length === 0) {
    console.log("No real comments to post");
    return;
  }

  const octokit = createOctokit(githubToken).rest;
  const pull_number = parseInt(prNumber, 10);
  const pr = await octokit.pulls.get({ owner, repo, pull_number });
  const headSha = pr.data.head.sha;

  console.log(`Posting ${toPost.length} classified-as-real comment(s)`);
  let posted = 0;
  for (const c of toPost) {
    if (await postComment(octokit, owner, repo, pull_number, headSha, c)) {
      console.log(`  posted ${c.path}:${c.line}`);
      posted++;
    }
  }
  console.log(`Posted ${posted}/${toPost.length}`);
}

main().catch((e) => {
  console.error("post-buffered-inline-comments failed:", e);
  process.exit(1);
});
