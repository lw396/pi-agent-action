// classifyComments(): the classification of buffered inline comments, run
// through pi's ModelRuntime with a scripted provider instead of a real model.
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { classifyComments } from "../../src/runner/classify-comments";

const PROVIDER = "faux";

function classifierModel(id: string): ClassifierModel<string> {
  return {
    id,
    name: id,
    api: "faux-classifier",
    provider: PROVIDER,
    baseUrl: "http://localhost",
    input: ["text"],
    cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    type: "classifier",
    contextWindow: 8192,
  };
}

type Setup = {
  chat?: FauxResponseStep[];
  classifiers?: string[];
  /** Probabilities the classifier answers with, by question key. */
  classify?: (context: ClassifierContext) => Partial<ClassifierResult>;
};

type Harness = {
  modelRuntime: ModelRuntime;
  classifyCalls: Array<{ model: string; context: ClassifierContext }>;
  chatCalls: () => number;
  keysSeen: string[];
};

async function harness(setup: Setup): Promise<Harness> {
  const faux = fauxProvider({
    provider: PROVIDER,
    models: [
      { id: "chat-model", reasoning: false },
      { id: "other-chat", reasoning: false },
    ],
  });
  faux.setResponses(setup.chat ?? []);
  const classifiers = (setup.classifiers ?? []).map(classifierModel);
  const classifyCalls: Harness["classifyCalls"] = [];
  const keysSeen: string[] = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: { apiKey: envApiKeyAuth("Faux API key", ["FAUX_TEST_API_KEY"]) },
    getAllModels: () => [...faux.models, ...classifiers],
    async classify(model, context, options) {
      classifyCalls.push({ model: model.id, context });
      if (options?.apiKey) keysSeen.push(options.apiKey);
      const answers = Object.fromEntries(
        Object.keys(context.questions).map((key) => [
          key,
          { type: "bool" as const, probability: 0.9 },
        ]),
      );
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: {
            input: 0.001,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.001,
          },
        },
        ...setup.classify?.(context),
      } as ClassifierResult;
    },
  });
  return {
    modelRuntime,
    classifyCalls,
    chatCalls: () => faux.state.callCount,
    keysSeen,
  };
}

let savedKey: string | undefined;
let logs: string[];
let warnings: string[];
let restoreLogs: () => void;
beforeEach(() => {
  savedKey = process.env.FAUX_TEST_API_KEY;
  process.env.FAUX_TEST_API_KEY = "key-from-the-environment";
  logs = [];
  warnings = [];
  const info = spyOn(core, "info").mockImplementation((m) => {
    logs.push(m);
  });
  const warning = spyOn(core, "warning").mockImplementation((m) => {
    warnings.push(String(m));
  });
  restoreLogs = () => {
    info.mockRestore();
    warning.mockRestore();
  };
});
afterEach(() => {
  restoreLogs();
  if (savedKey === undefined) delete process.env.FAUX_TEST_API_KEY;
  else process.env.FAUX_TEST_API_KEY = savedKey;
});

const BODIES = ["This loop is off by one.", "Test comment"];
const JEV = `${PROVIDER}/jev-1.13`;

describe("classifyComments", () => {
  test("uses the model input's chat model when classify_model is not set, even if the provider has a classifier", async () => {
    const h = await harness({
      classifiers: ["jev-1.13"],
      chat: [fauxAssistantMessage("[true, false]")],
    });
    const verdicts = await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([true, false]);
    expect(h.chatCalls()).toBe(1);
    expect(h.classifyCalls).toHaveLength(0);
    expect(logs.join("\n")).toContain("faux/chat-model");
  });

  test("asks a classifier named in classify_model one bool question per comment", async () => {
    const h = await harness({
      classifiers: ["jev-1.13", "kev-4b"],
      classify: (context) => ({
        answers: Object.fromEntries(
          Object.keys(context.questions).map((key, i) => [
            key,
            { type: "bool" as const, probability: i === 0 ? 0.8 : 0.1 },
          ]),
        ),
      }),
    });
    const verdicts = await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      classifyModel: `${PROVIDER}/kev-4b`,
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([true, false]);
    expect(h.classifyCalls.map((c) => c.model)).toEqual(["kev-4b"]);
    // Every comment is in the state and has a bool question of its own.
    const { state, questions } = h.classifyCalls[0]!.context;
    expect(JSON.stringify(state)).toContain(BODIES[0]!);
    expect(JSON.stringify(state)).toContain(BODIES[1]!);
    expect(Object.values(questions).map((q) => q.type)).toEqual([
      "bool",
      "bool",
    ]);
    expect(h.chatCalls()).toBe(0);
    expect(logs.join("\n")).toMatch(/faux\/kev-4b.*10 tokens.*\$0\.0010/);
  });

  test("uses a chat model named in classify_model", async () => {
    const h = await harness({
      classifiers: ["jev-1.13"],
      chat: [fauxAssistantMessage("Answer: [false, true]")],
    });
    const verdicts = await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      classifyModel: `${PROVIDER}/other-chat`,
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([false, true]);
    expect(h.classifyCalls).toHaveLength(0);
  });

  test("works with classify_model alone, without the model input", async () => {
    const h = await harness({ classifiers: ["jev-1.13"] });
    const verdicts = await classifyComments(BODIES, {
      classifyModel: JEV,
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([true, true]);
  });

  test("the api_key input authenticates the model input's provider", async () => {
    delete process.env.FAUX_TEST_API_KEY;
    const h = await harness({ classifiers: ["jev-1.13"] });
    const verdicts = await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      classifyModel: JEV,
      apiKey: "key-from-the-input",
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([true, true]);
    expect(h.keysSeen).toEqual(["key-from-the-input"]);
  });

  describe("returns null, so every comment is posted", () => {
    test("when neither model nor classify_model is set", async () => {
      const h = await harness({ classifiers: ["jev-1.13"] });
      expect(
        await classifyComments(BODIES, { modelRuntime: h.modelRuntime }),
      ).toBeNull();
    });

    test("when classify_model names an unknown provider", async () => {
      const h = await harness({ classifiers: ["jev-1.13"] });
      expect(
        await classifyComments(BODIES, {
          model: `${PROVIDER}/chat-model`,
          classifyModel: "no-such-provider/model",
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
      expect(warnings.join("\n")).toContain(
        "classify_model 'no-such-provider/model' is not a model pi knows",
      );
      expect(h.classifyCalls).toHaveLength(0);
      expect(h.chatCalls()).toBe(0);
    });

    test("when the classifier's provider has no credentials", async () => {
      delete process.env.FAUX_TEST_API_KEY;
      const h = await harness({ classifiers: ["jev-1.13"] });
      expect(
        await classifyComments(BODIES, {
          classifyModel: JEV,
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
    });

    test("when the classifier stops with an error, without trying another model", async () => {
      const h = await harness({
        classifiers: ["jev-1.13"],
        chat: [fauxAssistantMessage("[true, true]")],
        classify: () => ({
          stopReason: "error",
          errorMessage: "rate limited",
          answers: {},
        }),
      });
      expect(
        await classifyComments(BODIES, {
          model: `${PROVIDER}/chat-model`,
          classifyModel: JEV,
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
      expect(logs.join("\n")).toContain("rate limited");
      expect(h.chatCalls()).toBe(0);
    });

    test("when the classifier leaves a comment unanswered", async () => {
      const h = await harness({
        classifiers: ["jev-1.13"],
        classify: () => ({
          answers: { c1: { type: "bool", probability: 0.9 } },
        }),
      });
      expect(
        await classifyComments(BODIES, {
          classifyModel: JEV,
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
    });

    test("when the chat model's answer cannot be parsed", async () => {
      const h = await harness({ chat: [fauxAssistantMessage("Not sure.")] });
      expect(
        await classifyComments(BODIES, {
          model: `${PROVIDER}/chat-model`,
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
    });

    test("when the chat model answers for the wrong number of comments", async () => {
      const h = await harness({ chat: [fauxAssistantMessage("[true]")] });
      expect(
        await classifyComments(BODIES, {
          model: `${PROVIDER}/chat-model`,
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
    });
  });
});
