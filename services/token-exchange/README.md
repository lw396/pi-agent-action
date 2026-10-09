# Token exchange service

When a workflow does not set `github_token`, the action sends the workflow's GitHub OIDC token to this service and gets back an installation token for the [pi-agent-action](https://github.com/apps/pi-agent-action) GitHub App. The service runs on Cloudflare Workers.

Endpoint: `https://pi-agent-action.8d7h5sbqdh.workers.dev/api/github/github-app-token-exchange`

## API

Same as the upstream exchange service:

- `POST` with `Authorization: Bearer <OIDC token>`; the OIDC audience is `pi-agent-action`
- Optional body `{"permissions": {"contents": "write", ...}}`; without it the token gets the default permissions: `contents`, `pull_requests` and `issues` write
- Success: `200 {"token": "..."}`; the token only works on the repository named in the OIDC token
- Failure: `{"error": {"message": "...", "details": {"error_code": "..."}}}`

| Status | `error_code`                           | Meaning                                                                           |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------- |
| 400    | `invalid_request`                      | The body is not valid JSON, or `permissions` is malformed                         |
| 401    | `missing_oidc_token`                   | No `Authorization: Bearer` header                                                 |
| 401    | `invalid_oidc_token`                   | The signature, `iss`, `aud` or `exp` / `nbf` check failed, or a claim is missing  |
| 401    | `workflow_not_found_on_default_branch` | The workflow file is not on the default branch, or differs from the run's version |
| 403    | `permissions_exceeded`                 | The requested permissions exceed what the App installation has                    |
| 403    | `app_suspended`                        | The App installation on the repository is suspended                               |
| 404    | `app_not_installed`                    | The App is not installed on the repository                                        |
| 404    | `not_found` / 405 `method_not_allowed` | Wrong path or method                                                              |
| 500    | `server_misconfigured`                 | Configuration is missing, or the private key cannot be imported                   |
| 502    | `oidc_keys_unavailable`                | The GitHub Actions JWKS could not be fetched                                      |
| 502    | `github_api_error`                     | A GitHub API request failed                                                       |

Workflow check: the calling workflow (`workflow_ref`, `workflow_sha`) must match the version on the default branch. So must a reusable workflow from the same repository (`job_workflow_ref`, `job_workflow_sha`); a reusable workflow from another repository is pinned by the caller's file and not checked separately. The files are read with a temporary token that has only `contents: read`, which is revoked right after the check.

## Configuration

| Name                     | Where                                 | Value                                       |
| ------------------------ | ------------------------------------- | ------------------------------------------- |
| `GITHUB_APP_ID`          | `wrangler.toml` `[vars]`              | `5246881`                                   |
| `GITHUB_APP_SLUG`        | `wrangler.toml` `[vars]`              | `pi-agent-action`                           |
| `OIDC_AUDIENCE`          | `wrangler.toml` `[vars]`              | `pi-agent-action`                           |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret (not in the repository) | The App's private key, PKCS#1 or PKCS#8 PEM |

The `.pem` file GitHub gives you is PKCS#1 and works as is; no conversion needed.

## Deployment

You need Workers access on the Cloudflare account. Run every command below from this directory (`services/token-exchange/`).

1. Log in to Cloudflare:

   ```bash
   bunx wrangler@4 login
   ```

2. Store the private key. Reading it from the file keeps the key out of your shell history:

   ```bash
   bunx wrangler@4 secret put GITHUB_APP_PRIVATE_KEY < /path/to/pi-agent-action.private-key.pem
   ```

   Then delete the local `.pem` and keep the only copy in a password manager.

3. Deploy:

   ```bash
   bunx wrangler@4 deploy
   ```

4. Check that the service is up. A request without a token should return `401` with `missing_oidc_token`:

   ```bash
   curl -s -X POST https://pi-agent-action.8d7h5sbqdh.workers.dev/api/github/github-app-token-exchange
   ```

Live logs: `bunx wrangler@4 tail`. The logs contain repository names, permissions and error codes, never tokens or the private key.
