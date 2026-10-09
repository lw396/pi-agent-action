import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * The inline comment server buffers calls without confirmed=true here, and
 * the action's post-step classifies and posts them after the session.
 */

/** One buffered create_inline_comment call, a line of the buffer file. */
export type BufferedComment = {
  ts: string;
  path: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
  body: string;
  confirmed?: boolean;
};

/**
 * The buffer file, under RUNNER_TEMP: it holds this job's comments only, not
 * those another job on a reused self-hosted runner left in /tmp.
 */
export function inlineCommentBufferPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(env.RUNNER_TEMP || tmpdir(), "pi-inline-comments.jsonl");
}

export function appendBufferedComment(
  comment: BufferedComment,
  bufferPath: string,
): void {
  appendFileSync(bufferPath, JSON.stringify(comment) + "\n");
}

/** The buffered comments, in call order; none when there is no buffer. */
export function readBufferedComments(bufferPath: string): BufferedComment[] {
  if (!existsSync(bufferPath)) return [];
  return readFileSync(bufferPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export type BufferedCommentMatch = {
  path: string;
  line?: number;
  startLine?: number;
  body: string;
};

/**
 * Remove any buffered inline comment that matches an already-posted comment.
 *
 * When a comment is posted live (confirmed=true), an earlier buffered copy of
 * the same comment must be dropped so the post-session replay step does not
 * post it a second time. The model frequently re-issues a buffered call with
 * confirmed=true after reading the "Set confirmed=true to post immediately"
 * reply; previously the original buffered entry was left behind and replayed,
 * producing duplicate inline comments.
 *
 * Entries are matched on path, line, startLine and body. Lines that cannot be
 * parsed are kept untouched.
 */
export function removeBufferedComment(
  match: BufferedCommentMatch,
  bufferPath: string,
): void {
  if (!existsSync(bufferPath)) {
    return;
  }

  const remaining = readFileSync(bufferPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      let entry: BufferedCommentMatch;
      try {
        entry = JSON.parse(line);
      } catch {
        // Keep anything we cannot parse rather than silently dropping it.
        return true;
      }
      const isSameComment =
        entry.path === match.path &&
        entry.line === match.line &&
        entry.startLine === match.startLine &&
        entry.body === match.body;
      return !isSameComment;
    });

  writeFileSync(
    bufferPath,
    remaining.length > 0 ? remaining.join("\n") + "\n" : "",
  );
}
