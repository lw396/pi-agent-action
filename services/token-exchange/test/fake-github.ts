import {
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { FetchFn } from "../src/oidc";
import { GITHUB_ACTIONS_ISSUER, GITHUB_ACTIONS_JWKS_URL } from "../src/oidc";

export const AUDIENCE = "pi-agent-action";
export const APP_ID = "5246881";
export const NOW = 1_800_000_000;
export const REPOSITORY = "octo-org/octo-repo";
export const REPOSITORY_ID = "123456";
export const WORKFLOW_PATH = ".github/workflows/pi.yml";
export const RUN_SHA = "a".repeat(40);
export const INSTALLATION_ID = 42;

function rsaKeyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

// Generated once: RSA key generation is slow.
export const oidcKeys = rsaKeyPair();
export const otherOidcKeys = rsaKeyPair();
export const appKeys = rsaKeyPair();

// GitHub's download format.
export const APP_PRIVATE_KEY_PKCS1 = appKeys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
export const APP_PRIVATE_KEY_PKCS8 = appKeys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject = oidcKeys.privateKey,
): string {
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(input).sign(key);
  return `${input}.${base64Url(signature)}`;
}

export function oidcClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const workflowRef = `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`;
  return {
    iss: GITHUB_ACTIONS_ISSUER,
    aud: AUDIENCE,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 300,
    repository: REPOSITORY,
    repository_id: REPOSITORY_ID,
    repository_owner: "octo-org",
    workflow_ref: workflowRef,
    workflow_sha: RUN_SHA,
    job_workflow_ref: workflowRef,
    job_workflow_sha: RUN_SHA,
    ...overrides,
  };
}

export function oidcToken(
  overrides: Record<string, unknown> = {},
  options: { key?: KeyObject; header?: Record<string, unknown> } = {},
): string {
  return signJwt(
    { alg: "RS256", kid: "key-1", typ: "JWT", ...options.header },
    oidcClaims(overrides),
    options.key,
  );
}

export type Call = {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
};

type Blobs = Record<string, Record<string, string>>;

// An in-memory stand-in for api.github.com and the GitHub Actions JWKS.
export class FakeGitHub {
  installed = true;
  suspended = false;
  installationPermissions: Record<string, string> = {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  };
  defaultBranch = "main";
  // ref -> path -> blob SHA
  blobs: Blobs = {
    main: { [WORKFLOW_PATH]: "blob-1" },
    [RUN_SHA]: { [WORKFLOW_PATH]: "blob-1" },
  };
  jwksKids = ["key-1"];
  calls: Call[] = [];
  issuedTokens: string[] = [];
  revokedTokens: string[] = [];

  fetch: FetchFn = async (input, init) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const authorization = headers.get("Authorization");
    this.calls.push({ method, url: input, authorization, body });

    if (input === GITHUB_ACTIONS_JWKS_URL) {
      const jwk = oidcKeys.publicKey.export({ format: "jwk" });
      return json(200, {
        keys: this.jwksKids.map((kid) => ({ ...jwk, kid, use: "sig" })),
      });
    }

    const url = new URL(input);
    const path = url.pathname;

    if (method === "GET" && path === `/repos/${REPOSITORY}/installation`) {
      this.expectAppJwt(authorization);
      if (!this.installed) return json(404, { message: "Not Found" });
      return json(200, {
        id: INSTALLATION_ID,
        permissions: this.installationPermissions,
        suspended_at: this.suspended ? "2026-01-01T00:00:00Z" : null,
      });
    }

    if (
      method === "POST" &&
      path === `/app/installations/${INSTALLATION_ID}/access_tokens`
    ) {
      this.expectAppJwt(authorization);
      const token = `ghs_issued_${this.issuedTokens.length + 1}`;
      this.issuedTokens.push(token);
      return json(201, { token, expires_at: "2026-01-01T01:00:00Z" });
    }

    if (method === "DELETE" && path === "/installation/token") {
      this.revokedTokens.push(bearer(authorization));
      return new Response(null, { status: 204 });
    }

    if (method === "GET" && path === `/repos/${REPOSITORY}`) {
      this.expectIssuedToken(authorization);
      return json(200, { default_branch: this.defaultBranch });
    }

    const contentsPrefix = `/repos/${REPOSITORY}/contents/`;
    if (method === "GET" && path.startsWith(contentsPrefix)) {
      this.expectIssuedToken(authorization);
      const filePath = decodeURIComponent(path.slice(contentsPrefix.length));
      const sha = this.blobs[url.searchParams.get("ref") ?? ""]?.[filePath];
      if (!sha) return json(404, { message: "Not Found" });
      return json(200, { type: "file", path: filePath, sha });
    }

    return json(500, { message: `Unexpected request: ${method} ${input}` });
  };

  callsTo(method: string, pathSuffix: string): Call[] {
    return this.calls.filter(
      (call) => call.method === method && call.url.includes(pathSuffix),
    );
  }

  private expectAppJwt(authorization: string | null) {
    const [header, payload, signature] = bearer(authorization).split(".");
    const valid = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(appKeys.publicKey, Buffer.from(signature ?? "", "base64url"));
    if (!valid) throw new Error("App JWT signature is invalid");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    if (claims.iss !== APP_ID) throw new Error("App JWT iss is wrong");
  }

  private expectIssuedToken(authorization: string | null) {
    const token = bearer(authorization);
    if (
      !this.issuedTokens.includes(token) ||
      this.revokedTokens.includes(token)
    ) {
      throw new Error("Request without a live installation token");
    }
  }
}

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer /, "") ?? "";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
