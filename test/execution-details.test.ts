// The tracking comment's duration and cost, read from the Runner's
// Execution file (issue #9).
import { describe, expect, test } from "bun:test";
import { executionDetailsFrom } from "../src/entrypoints/update-comment-link";

describe("executionDetailsFrom", () => {
  test("reads the duration and cost from the closing session_stats record", () => {
    const records = [
      { type: "session", id: "abc" },
      { type: "agent_settled" },
      { type: "session_stats", cost: 0.0123, durationMs: 65_000 },
    ];

    expect(executionDetailsFrom(records)).toEqual({
      total_cost_usd: 0.0123,
      duration_ms: 65_000,
    });
  });

  test("is null for anything else", () => {
    expect(executionDetailsFrom([])).toBeNull();
    expect(executionDetailsFrom({})).toBeNull();
    expect(executionDetailsFrom([{ type: "agent_settled" }])).toBeNull();
    expect(
      executionDetailsFrom([{ type: "session_stats", cost: 1 }]),
    ).toBeNull();
  });
});
