import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleRequest, TOKEN_EXCHANGE_PATH, type Env } from "../src/handler";
import { createJwksProvider } from "../src/oidc";
import {
  APP_ID,
  APP_PRIVATE_KEY_PKCS1,
  APP_PRIVATE_KEY_PKCS8,
  AUDIENCE,
  FakeGitHub,
  NOW,
  oidcToken,
  otherOidcKeys,
  REPOSITORY,
  REPOSITORY_ID,
  RUN_SHA,
  signJwt,
  oidcClaims,
  WORKFLOW_PATH,
} from "./fake-github";

const ENV: Env = {
  GITHUB_APP_ID: APP_ID,
  GITHUB_APP_SLUG: "pi-agent-action",
  GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY_PKCS1,
  OIDC_AUDIENCE: AUDIENCE,
};

const URL_BASE = "https://pi-agent-action.example.workers.dev";

let github: FakeGitHub;
let logs: string[];
let logSpies: ReturnType<typeof spyOn>[];

beforeEach(() => {
  github = new FakeGitHub();
  logs = [];
  logSpies = (["log", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }),
  );
});

afterEach(() => {
  for (const spy of logSpies) spy.mockRestore();
});

type Options = {
  token?: string | null;
  body?: unknown;
  method?: string;
  path?: string;
  env?: Partial<Env>;
};

async function exchange(options: Options = {}) {
  const token = options.token === undefined ? oidcToken() : options.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const request = new Request(
    `${URL_BASE}${options.path ?? TOKEN_EXCHANGE_PATH}`,
    {
      method: options.method ?? "POST",
      headers,
      body:
        options.body === undefined
          ? undefined
          : typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body),
    },
  );
  const now = () => NOW;
  const response = await handleRequest(
    request,
    { ...ENV, ...options.env },
    {
      fetch: github.fetch,
      jwks: createJwksProvider(github.fetch, now),
      now,
    },
  );
  const text = await response.text();
  return { response, text, body: JSON.parse(text) };
}

function finalTokenRequests() {
  return github
    .callsTo("POST", "/access_tokens")
    .filter(
      (call) =>
        JSON.stringify((call.body as { permissions: unknown }).permissions) !==
        JSON.stringify({ contents: "read" }),
    );
}

describe("successful exchange", () => {
  test("returns an installation token with the default permissions", async () => {
    const { response, body } = await exchange();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({ token: "ghs_issued_2" });

    const [request] = finalTokenRequests();
    expect(request?.body).toEqual({
      repository_ids: [Number(REPOSITORY_ID)],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
      },
    });
  });

  test("an empty body gets the default permissions", async () => {
    const { response } = await exchange({ body: "" });
    expect(response.status).toBe(200);
    expect(
      (finalTokenRequests()[0]?.body as { permissions: unknown }).permissions,
    ).toEqual({ contents: "write", pull_requests: "write", issues: "write" });
  });

  test("passes requested permissions the installation has", async () => {
    const permissions = {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      actions: "read",
    };
    const { response } = await exchange({ body: { permissions } });

    expect(response.status).toBe(200);
    expect(finalTokenRequests()[0]?.body).toEqual({
      repository_ids: [Number(REPOSITORY_ID)],
      permissions,
    });
  });

  test("accepts a PKCS#8 private key", async () => {
    const { response } = await exchange({
      env: { GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY_PKCS8 },
    });
    expect(response.status).toBe(200);
  });

  test("accepts a private key stored with escaped newlines", async () => {
    const { response } = await exchange({
      env: {
        GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY_PKCS1.replace(/\n/g, "\\n"),
      },
    });
    expect(response.status).toBe(200);
  });

  test("revokes the token used for the workflow check", async () => {
    await exchange();
    expect(github.revokedTokens).toEqual(["ghs_issued_1"]);
    const [checkToken] = github.callsTo("POST", "/access_tokens");
    expect(checkToken?.body).toEqual({
      repository_ids: [Number(REPOSITORY_ID)],
      permissions: { contents: "read" },
    });
  });

  test("accepts an audience array that includes ours", async () => {
    const { response } = await exchange({
      token: oidcToken({ aud: ["other", AUDIENCE] }),
    });
    expect(response.status).toBe(200);
  });
});

describe("request validation", () => {
  test("unknown paths return 404", async () => {
    const { response, body } = await exchange({ path: "/" });
    expect(response.status).toBe(404);
    expect(body.error.details.error_code).toBe("not_found");
  });

  test("methods other than POST return 405", async () => {
    const { response } = await exchange({ method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  test("a missing Authorization header returns 401", async () => {
    const { response, body } = await exchange({ token: null });
    expect(response.status).toBe(401);
    expect(body.error.details.error_code).toBe("missing_oidc_token");
  });

  test.each([
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["permissions not an object", { permissions: "write" }],
    ["empty permissions", { permissions: {} }],
    ["unknown level", { permissions: { contents: "owner" } }],
    ["bad name", { permissions: { "contents;": "read" } }],
  ])("a body that is %s returns 400", async (_, body) => {
    const { response, body: json } = await exchange({ body });
    expect(response.status).toBe(400);
    expect(json.error.details.error_code).toBe("invalid_request");
    expect(github.issuedTokens).toEqual([]);
  });

  test("missing configuration returns 500 without naming values", async () => {
    const { response, body } = await exchange({
      env: { GITHUB_APP_PRIVATE_KEY: "" },
    });
    expect(response.status).toBe(500);
    expect(body.error.details.error_code).toBe("server_misconfigured");
    expect(logs.join("\n")).toContain("GITHUB_APP_PRIVATE_KEY");
  });

  test("an unreadable private key returns 500", async () => {
    const { response, body } = await exchange({
      env: { GITHUB_APP_PRIVATE_KEY: "not a key" },
    });
    expect(response.status).toBe(500);
    expect(body.error.details.error_code).toBe("server_misconfigured");
  });
});

describe("OIDC token verification", () => {
  test.each([
    [
      "signed with another key",
      () => oidcToken({}, { key: otherOidcKeys.privateKey }),
    ],
    ["from another issuer", () => oidcToken({ iss: "https://example.com" })],
    [
      "for another audience",
      () => oidcToken({ aud: "claude-code-github-action" }),
    ],
    ["expired", () => oidcToken({ exp: NOW })],
    ["without exp", () => oidcToken({ exp: undefined })],
    ["not valid yet", () => oidcToken({ nbf: NOW + 120 })],
    ["using alg none", () => oidcToken({}, { header: { alg: "none" } })],
    ["using HS256", () => oidcToken({}, { header: { alg: "HS256" } })],
    ["with an unknown kid", () => oidcToken({}, { header: { kid: "key-9" } })],
    ["malformed", () => "not.a.jwt"],
    ["missing repository_id", () => oidcToken({ repository_id: undefined })],
    ["with a bad repository", () => oidcToken({ repository: "../x" })],
    ["with a bad workflow_sha", () => oidcToken({ workflow_sha: "main" })],
  ])("rejects a token %s with 401", async (_, makeToken) => {
    const { response, body } = await exchange({ token: makeToken() });
    expect(response.status).toBe(401);
    expect(body.error.details.error_code).toBe("invalid_oidc_token");
    expect(github.issuedTokens).toEqual([]);
  });

  test("tolerates small clock skew on nbf", async () => {
    const { response } = await exchange({
      token: oidcToken({ nbf: NOW + 30 }),
    });
    expect(response.status).toBe(200);
  });

  test("refetches the JWKS once for an unknown kid", async () => {
    const now = () => NOW;
    const jwks = createJwksProvider(github.fetch, now);
    expect(await jwks.getKey("key-1")).toBeDefined();
    expect(await jwks.getKey("key-2")).toBeUndefined();
    // Too soon after the last fetch: no refetch.
    expect(github.callsTo("GET", "/.well-known/jwks")).toHaveLength(1);

    let later = NOW;
    const rotated = createJwksProvider(github.fetch, () => later);
    await rotated.getKey("key-1");
    github.jwksKids = ["key-1", "key-2"];
    later += 61;
    expect(await rotated.getKey("key-2")).toBeDefined();
  });

  test("a token signed for another payload does not verify", async () => {
    const token = oidcToken();
    const [header, , signature] = token.split(".");
    const forged = signJwt(
      { alg: "RS256", kid: "key-1" },
      oidcClaims({ repository: "evil/repo" }),
    );
    const tampered = `${header}.${forged.split(".")[1]}.${signature}`;
    const { response } = await exchange({ token: tampered });
    expect(response.status).toBe(401);
  });
});

test("an unreachable JWKS returns 502", async () => {
  const working = github.fetch;
  github.fetch = async (input, init) =>
    input.includes("/.well-known/jwks")
      ? new Response("", { status: 503 })
      : working(input, init);
  const { response, body } = await exchange();
  expect(response.status).toBe(502);
  expect(body.error.details.error_code).toBe("oidc_keys_unavailable");
});

describe("installation", () => {
  test("tells the user to install the App or set github_token", async () => {
    github.installed = false;
    const { response, body } = await exchange();

    expect(response.status).toBe(404);
    expect(body.error.details.error_code).toBe("app_not_installed");
    expect(body.error.message).toContain(
      "https://github.com/apps/pi-agent-action",
    );
    expect(body.error.message).toContain("github_token");
    expect(body.error.message).toContain(REPOSITORY);
  });

  test("a suspended installation is refused", async () => {
    github.suspended = true;
    const { response, body } = await exchange();
    expect(response.status).toBe(403);
    expect(body.error.details.error_code).toBe("app_suspended");
    expect(github.issuedTokens).toEqual([]);
  });
});

describe("permissions", () => {
  test("refuses permissions the installation does not have", async () => {
    const { response, body } = await exchange({
      body: { permissions: { contents: "write", workflows: "write" } },
    });

    expect(response.status).toBe(403);
    expect(body.error.details.error_code).toBe("permissions_exceeded");
    expect(body.error.message).toContain("workflows: write");
    expect(github.issuedTokens).toEqual([]);
  });

  test("refuses a higher level than the installation has", async () => {
    const { response, body } = await exchange({
      body: { permissions: { actions: "write" } },
    });
    expect(response.status).toBe(403);
    expect(body.error.message).toContain(
      "actions: write (installation has read)",
    );
  });

  test("refuses the defaults when the installation only has read access", async () => {
    github.installationPermissions = {
      ...github.installationPermissions,
      contents: "read",
    };
    const { response, body } = await exchange();
    expect(response.status).toBe(403);
    expect(body.error.details.error_code).toBe("permissions_exceeded");
  });
});

describe("workflow on the default branch", () => {
  async function expectWorkflowRejected(options: Options = {}) {
    const { response, body } = await exchange(options);
    expect(response.status).toBe(401);
    expect(body.error.details.error_code).toBe(
      "workflow_not_found_on_default_branch",
    );
    // The action matches this phrase when error_code is absent.
    expect(body.error.message.toLowerCase()).toContain(
      "workflow validation failed",
    );
    expect(finalTokenRequests()).toEqual([]);
    expect(github.revokedTokens).toEqual(github.issuedTokens);
    return body;
  }

  test("rejects a workflow missing from the default branch", async () => {
    github.blobs.main = {};
    const body = await expectWorkflowRejected();
    expect(body.error.message).toContain("default branch (main)");
  });

  test("rejects a workflow whose content differs from the default branch", async () => {
    github.blobs[RUN_SHA] = { [WORKFLOW_PATH]: "blob-changed" };
    await expectWorkflowRejected();
  });

  test("checks against the repository's actual default branch", async () => {
    github.defaultBranch = "trunk";
    github.blobs = {
      trunk: { [WORKFLOW_PATH]: "blob-1" },
      [RUN_SHA]: { [WORKFLOW_PATH]: "blob-1" },
    };
    const { response } = await exchange();
    expect(response.status).toBe(200);
  });

  test("rejects a workflow_ref from another repository", async () => {
    await expectWorkflowRejected({
      token: oidcToken({
        workflow_ref: `evil/repo/${WORKFLOW_PATH}@refs/heads/main`,
      }),
    });
  });

  test("rejects a workflow_ref outside .github/workflows", async () => {
    await expectWorkflowRejected({
      token: oidcToken({
        workflow_ref: `${REPOSITORY}/.github/../x.yml@refs/heads/main`,
      }),
    });
  });

  test("checks a reusable workflow in the same repository", async () => {
    const reusable = ".github/workflows/reusable.yml";
    const jobSha = "b".repeat(40);
    const token = oidcToken({
      job_workflow_ref: `${REPOSITORY}/${reusable}@refs/pull/1/merge`,
      job_workflow_sha: jobSha,
    });

    // Changed only in the pull request: rejected.
    github.blobs.main![reusable] = "blob-r";
    github.blobs[jobSha] = { [reusable]: "blob-r-changed" };
    await expectWorkflowRejected({ token });

    // Same as the default branch: accepted.
    github = new FakeGitHub();
    github.blobs.main![reusable] = "blob-r";
    github.blobs[jobSha] = { [reusable]: "blob-r" };
    const { response } = await exchange({ token });
    expect(response.status).toBe(200);
  });

  test("does not check a reusable workflow from another repository", async () => {
    const { response } = await exchange({
      token: oidcToken({
        job_workflow_ref:
          "other-org/shared/.github/workflows/pi.yml@refs/tags/v1",
        job_workflow_sha: "c".repeat(40),
      }),
    });
    expect(response.status).toBe(200);
    expect(github.callsTo("GET", "other-org")).toEqual([]);
  });
});

describe("GitHub API failures", () => {
  test("return 502 without details from GitHub", async () => {
    const failing = github.fetch;
    github.fetch = async (input, init) =>
      input.includes("/installation") && init?.method !== "DELETE"
        ? new Response('{"message":"boom"}', { status: 500 })
        : failing(input, init);

    const { response, body } = await exchange();
    expect(response.status).toBe(502);
    expect(body.error.details.error_code).toBe("github_api_error");
  });
});

describe("secrets", () => {
  test("responses and logs never contain the key or tokens", async () => {
    const token = oidcToken();
    const results = [
      await exchange({ token }),
      await exchange({ token, body: { permissions: { workflows: "write" } } }),
    ];
    github.blobs.main = {};
    results.push(await exchange({ token }));

    const keyBody = APP_PRIVATE_KEY_PKCS1.split("\n")[1]!;
    const output = [...logs, ...results.map((result) => result.text)].join(
      "\n",
    );
    expect(output).not.toContain(token);
    expect(output).not.toContain(keyBody);
    expect(output).not.toContain("eyJ"); // no JWT of any kind
    // Only the successful response carries the issued token.
    for (const issued of github.issuedTokens) {
      expect(logs.join("\n")).not.toContain(issued);
    }
    expect(results[1]!.text).not.toContain("ghs_");
    expect(results[2]!.text).not.toContain("ghs_");
  });
});
