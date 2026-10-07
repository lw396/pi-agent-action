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

  test("defaults the triggers and branch prefix to pi branding", () => {
    expect(inputDefault("trigger_phrase")).toBe("@pi");
    expect(inputDefault("label_trigger")).toBe("pi");
    expect(inputDefault("branch_prefix")).toBe("pi/");
  });
});
