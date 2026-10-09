import {
  createGitHubClient,
  GitHubApiError,
  type GitHubClient,
  type Installation,
  type Permissions,
} from "./github";
import { importRsaPrivateKeyPem, signRs256Jwt } from "./jwt";
import {
  OidcError,
  verifyOidcToken,
  type FetchFn,
  type JwksProvider,
} from "./oidc";

// Same path as the upstream exchange service, so the action only swaps the host.
export const TOKEN_EXCHANGE_PATH = "/api/github/github-app-token-exchange";

// Same defaults as upstream; `additional_permissions` adds to these.
export const DEFAULT_PERMISSIONS: Permissions = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
};

const PERMISSION_LEVELS: Record<string, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

export type Env = {
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string;
  OIDC_AUDIENCE: string;
};

export type Deps = {
  fetch: FetchFn;
  jwks: JwksProvider;
  // Current time in seconds since the epoch.
  now: () => number;
};

class ExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExchangeError";
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  deps: Deps,
): Promise<Response> {
  try {
    const token = await exchange(request, env, deps);
    return jsonResponse(200, { token });
  } catch (error) {
    if (error instanceof ExchangeError) {
      console.warn(`Token exchange refused: ${error.code}: ${error.message}`);
      return errorResponse(error);
    }
    if (error instanceof GitHubApiError) {
      console.error(error.message);
      return errorResponse(
        new ExchangeError(
          502,
          "github_api_error",
          `A GitHub API request failed (${error.status}). Try again later, or set the github_token input.`,
        ),
      );
    }
    // Our own errors never carry credentials; log the message only.
    console.error(
      "Unexpected error:",
      error instanceof Error ? error.message : "unknown error",
    );
    return errorResponse(
      new ExchangeError(500, "internal_error", "Internal error"),
    );
  }
}

async function exchange(
  request: Request,
  env: Env,
  deps: Deps,
): Promise<string> {
  if (new URL(request.url).pathname !== TOKEN_EXCHANGE_PATH) {
    throw new ExchangeError(404, "not_found", "Not found");
  }
  if (request.method !== "POST") {
    throw new ExchangeError(
      405,
      "method_not_allowed",
      "Only POST is supported",
    );
  }
  checkConfig(env);

  const oidcToken = readBearerToken(request);
  const permissions = await readRequestedPermissions(request);

  let claims;
  try {
    claims = await verifyOidcToken(oidcToken, {
      audience: env.OIDC_AUDIENCE,
      jwks: deps.jwks,
      now: deps.now(),
    });
  } catch (error) {
    if (error instanceof OidcError) {
      throw new ExchangeError(401, "invalid_oidc_token", error.message);
    }
    console.error(
      "Loading the GitHub Actions JWKS failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    throw new ExchangeError(
      502,
      "oidc_keys_unavailable",
      "Could not load the GitHub Actions OIDC signing keys. Try again later, or set the github_token input.",
    );
  }
  const run = readRunClaims(claims);

  const github = createGitHubClient(deps.fetch);
  const appJwt = await createAppJwt(env, deps.now());

  const installation = await github.getRepositoryInstallation(
    appJwt,
    run.repository,
  );
  if (!installation) {
    throw new ExchangeError(
      404,
      "app_not_installed",
      `The ${env.GITHUB_APP_SLUG} GitHub App is not installed on ${run.repository}. ` +
        `Install it from https://github.com/apps/${env.GITHUB_APP_SLUG}, or set the github_token input.`,
    );
  }
  if (installation.suspended) {
    throw new ExchangeError(
      403,
      "app_suspended",
      `The ${env.GITHUB_APP_SLUG} GitHub App installation for ${run.repository} is suspended. ` +
        "Unsuspend it, or set the github_token input.",
    );
  }
  checkPermissions(permissions, installation);

  await checkWorkflowsOnDefaultBranch(github, appJwt, installation, run);

  const token = await github.createInstallationToken(
    appJwt,
    installation.id,
    run.repositoryId,
    permissions,
  );
  console.log(
    `Issued a token for ${run.repository} with ${formatPermissions(permissions)}`,
  );
  return token;
}

function checkConfig(env: Env): void {
  const missing = (
    [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_PRIVATE_KEY",
      "OIDC_AUDIENCE",
    ] as const
  ).filter((name) => !env[name]);
  if (missing.length > 0) {
    // Names only, never values.
    console.error(`Missing configuration: ${missing.join(", ")}`);
    throw new ExchangeError(
      500,
      "server_misconfigured",
      "The token exchange service is misconfigured",
    );
  }
}

function readBearerToken(request: Request): string {
  const match = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("Authorization") ?? "",
  );
  if (!match) {
    throw new ExchangeError(
      401,
      "missing_oidc_token",
      "Send the workflow's OIDC token as `Authorization: Bearer <token>`",
    );
  }
  return match[1]!;
}

async function readRequestedPermissions(
  request: Request,
): Promise<Permissions> {
  const text = await request.text();
  if (!text.trim()) return { ...DEFAULT_PERMISSIONS };

  const invalid = (message: string) =>
    new ExchangeError(400, "invalid_request", message);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid("Request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("Request body must be a JSON object");
  }
  const requested = (body as { permissions?: unknown }).permissions;
  if (requested === undefined) return { ...DEFAULT_PERMISSIONS };
  if (
    typeof requested !== "object" ||
    requested === null ||
    Array.isArray(requested)
  ) {
    throw invalid("`permissions` must be an object");
  }

  const entries = Object.entries(requested);
  if (entries.length === 0) {
    // GitHub reads an empty set as "everything the installation has".
    throw invalid("`permissions` must not be empty");
  }
  const permissions: Permissions = {};
  for (const [name, level] of entries) {
    if (!/^[a-z_]+$/.test(name)) {
      throw invalid(`Unknown permission name: ${JSON.stringify(name)}`);
    }
    if (typeof level !== "string" || !(level in PERMISSION_LEVELS)) {
      throw invalid(`Permission ${name} must be read, write or admin`);
    }
    permissions[name] = level;
  }
  return permissions;
}

type RunClaims = {
  repository: string;
  repositoryId: number;
  workflowRef: string;
  workflowSha: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
};

function readRunClaims(claims: Record<string, unknown>): RunClaims {
  const read = (name: string, pattern: RegExp): string => {
    const value = claims[name];
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new ExchangeError(
        401,
        "invalid_oidc_token",
        `OIDC token has no valid ${name} claim`,
      );
    }
    return value;
  };
  const sha = /^[0-9a-f]{40}$/;
  return {
    repository: read("repository", /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    repositoryId: Number(read("repository_id", /^[1-9][0-9]*$/)),
    workflowRef: read("workflow_ref", /@/),
    workflowSha: read("workflow_sha", sha),
    jobWorkflowRef: read("job_workflow_ref", /@/),
    jobWorkflowSha: read("job_workflow_sha", sha),
  };
}

async function createAppJwt(env: Env, now: number): Promise<string> {
  let key;
  try {
    key = await importRsaPrivateKeyPem(env.GITHUB_APP_PRIVATE_KEY);
  } catch {
    console.error("GITHUB_APP_PRIVATE_KEY could not be imported");
    throw new ExchangeError(
      500,
      "server_misconfigured",
      "The token exchange service is misconfigured",
    );
  }
  // iat is backdated to allow for clock drift; GitHub caps exp at 10 minutes.
  return signRs256Jwt(key, {
    iat: now - 60,
    exp: now + 540,
    iss: env.GITHUB_APP_ID,
  });
}

function checkPermissions(
  requested: Permissions,
  installation: Installation,
): void {
  const exceeded = Object.entries(requested)
    .filter(
      ([name, level]) =>
        (PERMISSION_LEVELS[level] ?? Infinity) >
        (PERMISSION_LEVELS[installation.permissions[name] ?? ""] ?? 0),
    )
    .map(
      ([name, level]) =>
        `${name}: ${level} (installation has ${installation.permissions[name] ?? "none"})`,
    );
  if (exceeded.length > 0) {
    throw new ExchangeError(
      403,
      "permissions_exceeded",
      `Requested permissions exceed what the GitHub App installation has: ${exceeded.join(", ")}`,
    );
  }
}

type WorkflowFile = { repository: string; path: string; sha: string };

// "owner/repo/.github/workflows/file.yml@refs/heads/main"
function parseWorkflowRef(ref: string, sha: string): WorkflowFile | null {
  const at = ref.indexOf("@");
  const parts = ref.slice(0, at).split("/");
  if (parts.length < 3) return null;
  const path = parts.slice(2).join("/");
  if (
    !path.startsWith(".github/workflows/") ||
    path.split("/").includes("..")
  ) {
    return null;
  }
  return { repository: `${parts[0]}/${parts[1]}`, path, sha };
}

// The workflow that asks for a token must be the one on the default branch,
// so a branch or pull request cannot change what the workflow does with it.
async function checkWorkflowsOnDefaultBranch(
  github: GitHubClient,
  appJwt: string,
  installation: Installation,
  run: RunClaims,
): Promise<void> {
  const sameRepository = (file: WorkflowFile) =>
    file.repository.toLowerCase() === run.repository.toLowerCase();

  const caller = parseWorkflowRef(run.workflowRef, run.workflowSha);
  if (!caller || !sameRepository(caller)) {
    throw workflowValidationError(run.workflowRef);
  }
  const files = [caller];

  // A reusable workflow in the same repository comes from the run's own
  // commit, so it is checked too. One in another repository is pinned by the
  // caller, which was checked above.
  const job = parseWorkflowRef(run.jobWorkflowRef, run.jobWorkflowSha);
  if (!job) {
    throw workflowValidationError(run.jobWorkflowRef);
  }
  if (
    sameRepository(job) &&
    (job.path !== caller.path || job.sha !== caller.sha)
  ) {
    files.push(job);
  }

  const readToken = await github.createInstallationToken(
    appJwt,
    installation.id,
    run.repositoryId,
    { contents: "read" },
  );
  try {
    const defaultBranch = await github.getDefaultBranch(
      readToken,
      run.repository,
    );
    for (const file of files) {
      const [onDefaultBranch, inRun] = await Promise.all([
        github.getFileBlobSha(
          readToken,
          run.repository,
          file.path,
          defaultBranch,
        ),
        github.getFileBlobSha(readToken, run.repository, file.path, file.sha),
      ]);
      if (!onDefaultBranch || onDefaultBranch !== inRun) {
        throw workflowValidationError(file.path, defaultBranch);
      }
    }
  } finally {
    await github.revokeInstallationToken(readToken).catch(() => {
      console.warn("Revoking the workflow check token failed");
    });
  }
}

function workflowValidationError(
  workflow: string,
  defaultBranch?: string,
): ExchangeError {
  const branch = defaultBranch
    ? `default branch (${defaultBranch})`
    : "default branch";
  return new ExchangeError(
    401,
    "workflow_not_found_on_default_branch",
    `Workflow validation failed: ${workflow} must exist on the repository's ${branch} ` +
      "with the same content as the version this run used. A workflow added or changed in a " +
      "branch or pull request starts working once the change is merged.",
  );
}

function formatPermissions(permissions: Permissions): string {
  return Object.entries(permissions)
    .map(([name, level]) => `${name}: ${level}`)
    .join(", ");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(error: ExchangeError): Response {
  const response = jsonResponse(error.status, {
    error: { message: error.message, details: { error_code: error.code } },
  });
  if (error.status === 405) response.headers.set("Allow", "POST");
  return response;
}
