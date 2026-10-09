#!/usr/bin/env bun

import * as core from "@actions/core";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { formatTurnsFromData } from "../../src/entrypoints/format-turns";
import { executionDetailsFrom } from "../../src/entrypoints/update-comment-link";
import {
  readExecutionFile,
  setExecutionFileOutputIfPresent,
} from "../../src/runner/execution-file";
import { runPi } from "../../src/runner/run-pi";
import { fauxRuntime, rules, useScratch } from "./harness";

describe("execution file output", () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    process.env.RUNNER_TEMP = originalRunnerTemp;
  });

  test("sets execution_file output when the default execution file exists", async () => {
    const setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    tempDir = await mkdtemp(join(tmpdir(), "claude-execution-file-"));
    process.env.RUNNER_TEMP = tempDir;
    const executionFile = join(tempDir, "pi-execution-output.json");
    await writeFile(executionFile, "[]");

    try {
      expect(setExecutionFileOutputIfPresent()).toBe(executionFile);
      expect(setOutputSpy).toHaveBeenCalledWith(
        "execution_file",
        executionFile,
      );
    } finally {
      setOutputSpy.mockRestore();
    }
  });
});

// The readers take the file runPi() writes, not hand-written records, so a
// change in pi's event shapes shows up here.
describe("the Execution file runPi() writes", () => {
  const getScratch = useScratch();

  test("is what the step summary and the tracking comment read", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Said hi."),
    ]);
    const result = await runPi("Say hi with bash.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: rules("Bash"),
    });

    const records = readExecutionFile(result.executionFile!);
    const summary = formatTurnsFromData(records);
    expect(summary).toContain("echo hi");
    expect(summary).toContain("Said hi.");
    expect(summary).toContain("## ✅ Final Result");

    const details = executionDetailsFrom(records);
    expect(details?.total_cost_usd).toBeNumber();
    expect(details?.duration_ms).toBeNumber();
  });
});
