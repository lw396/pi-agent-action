/**
 * Variables the bash tool keeps when it is isolated (ADR-0002). Everything
 * else in the environment, including provider keys, GH_TOKEN and secrets the
 * workflow adds under its own names, is dropped; allowed_bash_env adds more.
 * Redaction by value treats every other value as a secret
 * (src/github/utils/secret-values.ts).
 *
 * Left out on purpose: GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT, GITHUB_STATE
 * and GITHUB_STEP_SUMMARY, because writing to those files changes later steps
 * of the job.
 */
export const BASH_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "CI",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "GITHUB_ACTIONS",
  "GITHUB_ACTION_PATH",
  "GITHUB_ACTOR",
  "GITHUB_ACTOR_ID",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_API_URL",
  "GITHUB_GRAPHQL_URL",
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REF_TYPE",
  "GITHUB_HEAD_REF",
  "GITHUB_BASE_REF",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_JOB",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKSPACE",
  // Set by the shell; the same directory as GITHUB_WORKSPACE in the action.
  "PWD",
  "OLDPWD",
  // Session metadata pi adds for the bash tool; its prompt mentions them.
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];
