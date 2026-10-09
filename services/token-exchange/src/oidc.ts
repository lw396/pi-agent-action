import { decodeJwt, importRsaPublicJwk, verifyRs256, type RsaJwk } from "./jwt";

export const GITHUB_ACTIONS_ISSUER =
  "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_JWKS_URL = `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`;

// Allowed clock difference for nbf / iat, in seconds.
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_SECONDS = 600;
// An unknown kid triggers a refetch (key rotation), at most this often.
const JWKS_MIN_REFRESH_SECONDS = 60;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type JwksProvider = {
  getKey(kid: string): Promise<CryptoKey | undefined>;
};

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

export function createJwksProvider(
  fetchFn: FetchFn,
  now: () => number,
): JwksProvider {
  let cache: { keys: Map<string, CryptoKey>; fetchedAt: number } | undefined;

  async function load() {
    const response = await fetchFn(GITHUB_ACTIONS_JWKS_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `Fetching the GitHub Actions JWKS failed (${response.status})`,
      );
    }
    const body = (await response.json()) as { keys?: RsaJwk[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      keys.set(jwk.kid, await importRsaPublicJwk(jwk));
    }
    return { keys, fetchedAt: now() };
  }

  return {
    async getKey(kid) {
      if (!cache || now() - cache.fetchedAt >= JWKS_TTL_SECONDS) {
        cache = await load();
      }
      let key = cache.keys.get(kid);
      if (!key && now() - cache.fetchedAt >= JWKS_MIN_REFRESH_SECONDS) {
        cache = await load();
        key = cache.keys.get(kid);
      }
      return key;
    },
  };
}

export async function verifyOidcToken(
  token: string,
  options: { audience: string; jwks: JwksProvider; now: number },
): Promise<Record<string, unknown>> {
  let decoded;
  try {
    decoded = decodeJwt(token);
  } catch {
    throw new OidcError("OIDC token is not a valid JWT");
  }

  const { header, payload } = decoded;
  if (header.alg !== "RS256") {
    throw new OidcError("OIDC token must be signed with RS256");
  }
  if (typeof header.kid !== "string") {
    throw new OidcError("OIDC token has no key ID");
  }

  const key = await options.jwks.getKey(header.kid);
  if (!key || !(await verifyRs256(key, decoded))) {
    throw new OidcError("OIDC token signature is invalid");
  }

  if (payload.iss !== GITHUB_ACTIONS_ISSUER) {
    throw new OidcError("OIDC token was not issued by GitHub Actions");
  }

  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(options.audience)) {
    throw new OidcError(`OIDC token audience must be "${options.audience}"`);
  }

  if (typeof payload.exp !== "number" || options.now >= payload.exp) {
    throw new OidcError("OIDC token has expired");
  }
  if (
    typeof payload.nbf === "number" &&
    options.now + CLOCK_SKEW_SECONDS < payload.nbf
  ) {
    throw new OidcError("OIDC token is not valid yet");
  }

  return payload;
}
