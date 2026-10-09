import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Builds the pi settings the Runner uses.
 *
 * Settings live only in memory: nothing is read from or written to
 * ~/.pi/agent/settings.json, so the agent cannot change configuration that
 * later processes in the job would read. The repository's .pi/settings.json is
 * not read either (see docs/development/upstream-divergence.md).
 *
 * This is an empty skeleton for settings the action will control later. Pass
 * every setting to inMemory() at once: values applied afterwards with
 * applyOverrides() are lost on reload (docs/development/pi-sdk-capabilities.md).
 */
export function setupPiSettings(): SettingsManager {
  return SettingsManager.inMemory({});
}
