// Test harness for the pi SDK capability checks (issue #2).
//
// Builds a fully in-memory pi session driven by the faux provider: no files
// under ~/.pi/agent are read or written, and no real model is called.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCurrentTools,
  InMemoryCredentialStore,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/** Names of the tools declared to the model in one provider request. */
export function declaredToolNames(context: TranscriptContext): string[] {
  return getCurrentTools(context.messages).map((tool) => tool.name);
}

/** Text of the latest tool result in one provider request. */
export function lastToolResultText(context: TranscriptContext): string {
  const last = context.messages.findLast((m) => m.role === "toolResult");
  if (last?.role !== "toolResult") return "";
  return last.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

export type ToolExecutionEnd = Extract<
  AgentSessionEvent,
  { type: "tool_execution_end" }
>;

export type FauxSession = {
  session: AgentSession;
  faux: FauxProviderHandle;
  /** Scratch working directory for the session; removed by dispose(). */
  cwd: string;
  /** Agent dir passed to pi; must stay empty, since settings live in memory. */
  agentDir: string;
  /** Every session event, in order. */
  events: AgentSessionEvent[];
  dispose: () => void;
};

export function toolExecutionEnds(session: FauxSession): ToolExecutionEnd[] {
  return session.events.filter(
    (event): event is ToolExecutionEnd => event.type === "tool_execution_end",
  );
}

export type FauxSessionOptions = {
  responses: FauxResponseStep[];
  extensionFactories?: InlineExtension[];
  /** Extra settings passed to SettingsManager.inMemory(). */
  settings?: Record<string, unknown>;
  sessionOptions?: Partial<CreateAgentSessionOptions>;
};

export async function createFauxSession(
  options: FauxSessionOptions,
): Promise<FauxSession> {
  const root = mkdtempSync(join(tmpdir(), "pi-sdk-test-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  await Bun.write(join(cwd, ".keep"), "");

  const faux = fauxProvider();
  faux.setResponses(options.responses);

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...options.settings,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: options.extensionFactories ?? [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    ...options.sessionOptions,
  });

  const events: FauxSession["events"] = [];
  session.subscribe((event) => {
    events.push(event);
  });

  return {
    session,
    faux,
    cwd,
    agentDir,
    events,
    dispose: () => {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
