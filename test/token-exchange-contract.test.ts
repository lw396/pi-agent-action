import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  OIDC_AUDIENCE,
  TOKEN_EXCHANGE_ORIGIN,
} from "../src/contracts/token-exchange";

// The pinned bun-types describes Bun.TOML but predates Bun.YAML, which the
// runtime has, so only the YAML parse signature is added here.
const { YAML } = Bun as unknown as { YAML: { parse(input: string): unknown } };

function readConfig(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

// YAML/TOML are independently deployed, so imports cannot enforce these links.
test("the exchange deployment accepts the action's audience and is reachable through the firewall", () => {
  const deployment = Bun.TOML.parse(
    readConfig("../services/token-exchange/wrangler.toml"),
  ) as { vars?: { OIDC_AUDIENCE?: string } };
  expect(deployment.vars?.OIDC_AUDIENCE).toBe(OIDC_AUDIENCE);

  const firewall = YAML.parse(
    readConfig("../.github/egress-firewall.yaml"),
  ) as {
    allow?: string[];
  };
  expect(firewall.allow).toContain(new URL(TOKEN_EXCHANGE_ORIGIN).hostname);
});
