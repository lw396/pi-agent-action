// Which buffered inline comments the post-step posts (issue #9): the rules
// run through postBufferedComments() with in-memory adapters for the
// classifier and GitHub.
import { describe, expect, spyOn, test, beforeEach, afterEach } from "bun:test";
import { postBufferedComments } from "../src/entrypoints/post-buffered-inline-comments";
import type { BufferedComment } from "../src/mcp/inline-comment-buffer";

function comment(
  body: string,
  extra: Partial<BufferedComment> = {},
): BufferedComment {
  return {
    ts: "2026-10-09T00:00:00.000Z",
    path: "src/a.ts",
    line: 1,
    body,
    ...extra,
  };
}

/** Adapters that record what was classified and posted. */
function adapters(
  verdicts: (bodies: string[]) => boolean[] | null,
  rejected: string[] = [],
) {
  const classified: string[][] = [];
  const posted: string[] = [];
  return {
    classified,
    posted,
    adapters: {
      classify: async (bodies: string[]) => {
        classified.push(bodies);
        return verdicts(bodies);
      },
      post: async (c: BufferedComment) => {
        if (rejected.includes(c.body)) return false;
        posted.push(c.body);
        return true;
      },
    },
  };
}

describe("postBufferedComments", () => {
  let logSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  test("posts the comments classified as real, in order, and drops probes", async () => {
    const run = adapters((bodies) => bodies.map((b) => !b.startsWith("test")));

    const outcome = await postBufferedComments(
      [comment("Null check missing"), comment("test comment"), comment("Typo")],
      run.adapters,
    );

    expect(run.posted).toEqual(["Null check missing", "Typo"]);
    expect(outcome.filtered.map((c) => c.body)).toEqual(["test comment"]);
  });

  test("never classifies or posts a comment buffered with confirmed=false", async () => {
    const run = adapters((bodies) => bodies.map(() => true));

    const outcome = await postBufferedComments(
      [comment("Real", { confirmed: false }), comment("Also real")],
      run.adapters,
    );

    expect(run.classified).toEqual([["Also real"]]);
    expect(run.posted).toEqual(["Also real"]);
    expect(outcome.unconfirmed.map((c) => c.body)).toEqual(["Real"]);
  });

  test("posts every candidate when classification is not possible", async () => {
    const run = adapters(() => null);

    const outcome = await postBufferedComments(
      [comment("A"), comment("B", { confirmed: false }), comment("test")],
      run.adapters,
    );

    expect(run.posted).toEqual(["A", "test"]);
    expect(outcome.filtered).toEqual([]);
  });

  test("does not classify when every comment is unconfirmed", async () => {
    const run = adapters(() => {
      throw new Error("not called");
    });

    await postBufferedComments(
      [comment("A", { confirmed: false })],
      run.adapters,
    );

    expect(run.classified).toEqual([]);
  });

  test("reports comments GitHub rejects and keeps posting the rest", async () => {
    const run = adapters((bodies) => bodies.map(() => true), ["Outdated line"]);

    const outcome = await postBufferedComments(
      [comment("Outdated line"), comment("Fine")],
      run.adapters,
    );

    expect(run.posted).toEqual(["Fine"]);
    expect(outcome.failed.map((c) => c.body)).toEqual(["Outdated line"]);
  });
});
