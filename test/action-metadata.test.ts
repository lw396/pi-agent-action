import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const metadata = readFileSync(
  new URL("../action.yml", import.meta.url),
  "utf8",
);

function inputDefault(name: string): string | undefined {
  const block = metadata.match(
    new RegExp(`^  ${name}:\\n((?:    .*\\n)+)`, "m"),
  )?.[1];
  return block?.match(/^    default: "(.*)"$/m)?.[1];
}

describe("action metadata", () => {
  test("should expose the conclusion output from the run step", () => {
    expect(metadata).toMatch(
      /^  conclusion:\n    description: .+\n    value: \$\{\{ steps\.run\.outputs\.conclusion \}\}$/m,
    );
  });

  test("passes the model, api_key and pi_args inputs to the run step", () => {
    expect(metadata).toMatch(
      /^  model:\n    description: .+\n    required: true$/m,
    );
    expect(metadata).toMatch(
      /^  api_key:\n    description: .+\n    required: false$/m,
    );
    expect(inputDefault("pi_args")).toBe("");
    expect(metadata).toContain("        MODEL: ${{ inputs.model }}\n");
    expect(metadata).toContain("        API_KEY: ${{ inputs.api_key }}\n");
    expect(metadata).toContain("        PI_ARGS: ${{ inputs.pi_args }}\n");
  });

  test("passes the allowed_tools and disallowed_tools inputs to the run step", () => {
    expect(inputDefault("allowed_tools")).toBe("");
    expect(inputDefault("disallowed_tools")).toBe("");
    expect(metadata).toContain(
      "        INPUT_ALLOWED_TOOLS: ${{ inputs.allowed_tools }}\n",
    );
    expect(metadata).toContain(
      "        INPUT_DISALLOWED_TOOLS: ${{ inputs.disallowed_tools }}\n",
    );
  });

  test("defaults the triggers and branch prefix to pi branding", () => {
    expect(inputDefault("trigger_phrase")).toBe("@pi");
    expect(inputDefault("label_trigger")).toBe("pi");
    expect(inputDefault("branch_prefix")).toBe("pi/");
  });
});
