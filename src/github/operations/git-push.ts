/** The action's push wrapper is both a prompt instruction and a tool grant. */
export function gitPushWrapper(): string {
  return `${process.env.GITHUB_ACTION_PATH}/scripts/git-push.sh`;
}
