/**
 * Whether the actor is in the allowed_bots input: a comma-separated list of
 * GitHub logins, or `*` for every bot. Logins are compared without GitHub's
 * `[bot]` suffix, so `dependabot` and `dependabot[bot]` match each other.
 */
export function isAllowedBot(actor: string, allowedBots: string): boolean {
  const trimmed = allowedBots.trim();
  if (trimmed === "*") return true;
  if (!trimmed) return false;

  const allowedList = trimmed
    .split(",")
    .map((bot) =>
      bot
        .trim()
        .toLowerCase()
        .replace(/\[bot\]$/, ""),
    )
    .filter((bot) => bot.length > 0);

  const normalizedActor = actor.toLowerCase().replace(/\[bot\]$/, "");
  return allowedList.includes(normalizedActor);
}
