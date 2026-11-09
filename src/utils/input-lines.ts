/**
 * Drop whole-line `#` comments from a multi-line input, as Upstream's
 * claude_args allows. Used by pi_args, allowed_tools, disallowed_tools, the
 * skills input and the packages input.
 */
export function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}
