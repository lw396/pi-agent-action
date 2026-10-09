import { handleRequest, type Env } from "./handler";
import { createJwksProvider, type FetchFn } from "./oidc";

const fetchFn: FetchFn = (input, init) => fetch(input, init);
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Lives as long as the isolate, so most requests skip the JWKS fetch.
const jwks = createJwksProvider(fetchFn, nowSeconds);

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, {
      fetch: fetchFn,
      jwks,
      now: nowSeconds,
    });
  },
};
