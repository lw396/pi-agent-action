// Wire contract shared by independently deployed action and exchange service.
// Route and default permissions retain Upstream compatibility; deployment env
// and firewall configuration are pinned by test/token-exchange-contract.test.ts.
export const TOKEN_EXCHANGE_ORIGIN =
  "https://pi-agent-action.8d7h5sbqdh.workers.dev";
export const TOKEN_EXCHANGE_PATH = "/api/github/github-app-token-exchange";
export const TOKEN_EXCHANGE_URL = `${TOKEN_EXCHANGE_ORIGIN}${TOKEN_EXCHANGE_PATH}`;
export const OIDC_AUDIENCE = "pi-agent-action";

export const WORKFLOW_VALIDATION_ERROR_CODE =
  "workflow_not_found_on_default_branch";

export const DEFAULT_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
} as const;
