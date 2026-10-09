import * as core from "@actions/core";
import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";

/**
 * The Execution file: a JSON array of records. The Runner writes pi's session
 * header first, then the session's events (`message_end`,
 * `tool_execution_end`, `agent_settled`, ...), and ends with one
 * `session_stats` record of the run's totals.
 */

const EXECUTION_FILENAME = "pi-execution-output.json";

/** One record of the Execution file. */
export type ExecutionRecord = {
  type: string;
  [key: string]: any;
};

/** The record that ends the file: pi's session stats and the run's duration. */
export type SessionStatsRecord = ExecutionRecord & {
  type: "session_stats";
  assistantMessages: number;
  tokens: { total: number };
  /** In US dollars. */
  cost: number;
  durationMs: number;
};

export function getExecutionFilePath(): string | undefined {
  if (!process.env.RUNNER_TEMP) {
    return undefined;
  }
  return join(process.env.RUNNER_TEMP, EXECUTION_FILENAME);
}

export async function writeExecutionFile(
  records: ExecutionRecord[],
): Promise<string | undefined> {
  const executionFile = getExecutionFilePath();
  if (!executionFile) {
    core.warning("Failed to write execution file: RUNNER_TEMP is not set");
    return undefined;
  }

  try {
    await writeFile(executionFile, JSON.stringify(records, null, 2));
    core.info(`Log saved to ${executionFile}`);
    return executionFile;
  } catch (error) {
    core.warning(`Failed to write execution file: ${error}`);
    return undefined;
  }
}

/** Read an Execution file. Throws when it is missing or not a JSON array. */
export function readExecutionFile(path: string): ExecutionRecord[] {
  const records: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(records)) {
    throw new Error(`${path} is not an Execution file: expected a JSON array`);
  }
  return records;
}

/** The closing session_stats record, if the run got far enough to write it. */
export function sessionStats(
  records: ExecutionRecord[],
): SessionStatsRecord | undefined {
  const last = records.at(-1);
  if (
    last?.type !== "session_stats" ||
    typeof last.cost !== "number" ||
    typeof last.durationMs !== "number"
  ) {
    return undefined;
  }
  return last as SessionStatsRecord;
}

export function setExecutionFileOutputIfPresent(): string | undefined {
  const executionFile = getExecutionFilePath();
  if (!executionFile || !existsSync(executionFile)) {
    return undefined;
  }

  core.setOutput("execution_file", executionFile);
  return executionFile;
}
