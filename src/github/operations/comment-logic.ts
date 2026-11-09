import { GITHUB_SERVER_URL } from "../api/config";
import { redactSecrets } from "../../security/sanitizer";
import { encodeBranchNameForUrl } from "./comments/common";

// The spinner the prompt asks the model to show while it works: an <img>
// whose URL ends in /spinner.gif (path boundary, then a quote or space), so
// other images in the comment stay.
const SPINNER_IMG = `<img[^>]*\/spinner\.gif(?=["'\s])[^>]*>`;
const SPINNER_LINE = new RegExp(`^[ \t]*${SPINNER_IMG}[ \t]*(?:\r?\n|$)`, "gm");
const SPINNER_INLINE = new RegExp(`[ \t]*${SPINNER_IMG}`, "g");

/**
 * Remove the spinners the model left, e.g. when the run failed before its
 * final update. A spinner on its own line starts an HTML block that runs to
 * the next blank line, so GitHub shows a list right under it as plain text.
 */
function removeSpinners(body: string): string {
  return body.replace(SPINNER_LINE, "").replace(SPINNER_INLINE, "");
}

export type ExecutionDetails = {
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
};

export type CommentUpdateInput = {
  currentBody: string;
  actionFailed: boolean;
  executionDetails: ExecutionDetails | null;
  jobUrl: string;
  branchLink?: string;
  prLink?: string;
  branchName?: string;
  triggerUsername?: string;
  errorDetails?: string;
  /** Where a failed run's unfinished work was saved, shown under the header. */
  wipNote?: string;
};

export function ensureProperlyEncodedUrl(url: string): string | null {
  try {
    new URL(url);
    if (url.includes(" ")) {
      const [baseUrl, queryString] = url.split("?");
      if (queryString) {
        const params = new URLSearchParams();
        const pairs = queryString.split("&");
        for (const pair of pairs) {
          const [key, value = ""] = pair.split("=");
          if (key) {
            params.set(key, decodeURIComponent(value));
          }
        }
        return `${baseUrl}?${params.toString()}`;
      }
      return url.replace(/ /g, "%20");
    }
    return url;
  } catch {
    try {
      let fixedUrl = url.replace(/ /g, "%20");

      // Ensure colons in parameter values are encoded (but not in http:// or after domain)
      const urlParts = fixedUrl.split("?");
      if (urlParts.length > 1 && urlParts[1]) {
        const [baseUrl, queryString] = urlParts;
        const fixedQuery = queryString.replace(/([^%]|^):(?!%2F%2F)/g, "$1%3A");
        fixedUrl = `${baseUrl}?${fixedQuery}`;
      }

      new URL(fixedUrl);
      return fixedUrl;
    } catch {
      return null;
    }
  }
}

export function updateCommentBody(input: CommentUpdateInput): string {
  const originalBody = input.currentBody;
  const {
    executionDetails,
    jobUrl,
    branchLink,
    prLink,
    actionFailed,
    branchName,
    triggerUsername,
    errorDetails,
    wipNote,
  } = input;

  const workingPattern = /pi is working[…\.]{1,3}(?:\s*<img[^>]*>)?/i;
  let bodyContent = removeSpinners(
    originalBody.replace(workingPattern, ""),
  ).trim();

  let prLinkFromContent = "";

  const prLinkPattern = /\[Create .* PR\]\((.*)\)$/m;
  const prLinkMatch = bodyContent.match(prLinkPattern);

  if (prLinkMatch && prLinkMatch[1]) {
    const encodedUrl = ensureProperlyEncodedUrl(prLinkMatch[1]);
    if (encodedUrl) {
      prLinkFromContent = encodedUrl;
      bodyContent = bodyContent.replace(prLinkMatch[0], "").trim();
    }
  }

  let durationStr = "";
  if (executionDetails?.duration_ms !== undefined) {
    const totalSeconds = Math.round(executionDetails.duration_ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  let header = "";

  if (actionFailed) {
    header = "**pi encountered an error";
    if (durationStr) {
      header += ` after ${durationStr}`;
    }
    header += "**";
  } else {
    const usernameMatch = bodyContent.match(/@([a-zA-Z0-9-]+)/);
    const username =
      triggerUsername || (usernameMatch ? usernameMatch[1] : "user");

    // The Runner only knows that the session ended normally, not whether the
    // request, its acceptance criteria or an independent review passed: the
    // header must not claim more. The body reports the task's outcome.
    header = `**Pi's run for @${username} ended`;
    if (durationStr) {
      header += ` after ${durationStr}`;
    }
    header += "**";
  }

  let links = ` —— [View job](${jobUrl})`;

  if (branchName || branchLink) {
    let finalBranchName = branchName;
    let branchUrl = "";

    if (branchLink) {
      const urlMatch = branchLink.match(/\((https:\/\/.*)\)/);
      if (urlMatch && urlMatch[1]) {
        branchUrl = urlMatch[1];
      }

      if (!finalBranchName) {
        const branchNameMatch = branchLink.match(/tree\/([^"'\)]+)/);
        if (branchNameMatch) {
          finalBranchName = branchNameMatch[1];
        }
      }
    }

    if (!branchUrl && finalBranchName) {
      const repoMatch = jobUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\//);
      if (repoMatch) {
        branchUrl = `${GITHUB_SERVER_URL}/${repoMatch[1]}/${repoMatch[2]}/tree/${encodeBranchNameForUrl(finalBranchName)}`;
      }
    }

    if (finalBranchName && branchUrl) {
      links += ` • [\`${finalBranchName}\`](${branchUrl})`;
    } else if (finalBranchName) {
      links += ` • \`${finalBranchName}\``;
    }
  }

  const prUrl =
    prLinkFromContent || (prLink ? prLink.match(/\(([^)]+)\)/)?.[1] : "");
  if (prUrl) {
    links += ` • [Create PR ➔](${prUrl})`;
  }

  let newBody = `${header}${links}`;

  // Add error details if available. The message may embed runtime credentials
  // (e.g. a token in a git remote URL) that are not registered as workflow
  // secrets, so redact known formats before posting.
  if (actionFailed && errorDetails) {
    newBody += `\n\n\`\`\`\n${redactSecrets(errorDetails)}\n\`\`\``;
  }

  if (wipNote) {
    newBody += `\n\n${wipNote}`;
  }

  newBody += `\n\n---\n`;

  bodyContent = bodyContent.replace(/\n?\[View job run\]\([^\)]+\)/g, "");
  bodyContent = bodyContent.replace(/\n?\[View branch\]\([^\)]+\)/g, "");

  bodyContent = bodyContent.replace(/\n*---\n*Duration: [0-9]+m? [0-9]+s/g, "");

  newBody += bodyContent;

  return newBody.trim();
}
