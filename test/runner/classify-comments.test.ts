// classifyComments(): the classification of buffered inline comments, run
// through pi's ModelRuntime with a scripted provider instead of a real model.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import {
  classifyComments,
  pickClassifierModel,
} from "../../src/runner/classify-comments";

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
let originalLog: typeof console.log;
beforeEach(() => {
  savedKey = process.env.FAUX_TEST_API_KEY;
  process.env.FAUX_TEST_API_KEY = "key-from-the-environment";
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
});
afterEach(() => {
  console.log = originalLog;
  if (savedKey === undefined) delete process.env.FAUX_TEST_API_KEY;
  else process.env.FAUX_TEST_API_KEY = savedKey;
});

const BODIES = ["This loop is off by one.", "Test comment"];

describe("pickClassifierModel", () => {
  test("picks the provider's paid jev model, preferring a pinned version", async () => {
    const h = await harness({
      classifiers: [
        "jev-1.13-free",
        "~typesafe/jev-latest",
        "typesafe/jev-1.13",
        "other/decider",
      ],
    });
    expect(pickClassifierModel(h.modelRuntime, PROVIDER)?.id).toBe(
      "typesafe/jev-1.13",
    );
  });

  test("picks jev-latest when it is the only paid jev model", async () => {
    const h = await harness({ classifiers: ["jev-latest", "jev:free"] });
    expect(pickClassifierModel(h.modelRuntime, PROVIDER)?.id).toBe(
      "jev-latest",
    );
  });

  test("picks nothing when the provider has no paid jev model", async () => {
    const h = await harness({ classifiers: ["jev-1.13-free", "other/clef"] });
    expect(pickClassifierModel(h.modelRuntime, PROVIDER)).toBeUndefined();
  });
});

describe("classifyComments", () => {
  test("uses the main model's jev classifier when classify_model is not set", async () => {
    const h = await harness({
      classifiers: ["jev-1.13"],
      classify: (context) => ({
        answers: {
          ...Object.fromEntries(
            Object.keys(context.questions).map((key, i) => [
              key,
              { type: "bool" as const, probability: i === 0 ? 0.8 : 0.1 },
            ]),
          ),
        },
      }),
    });
    const verdicts = await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([true, false]);
    expect(h.classifyCalls).toHaveLength(1);
    expect(h.classifyCalls[0]!.model).toBe("jev-1.13");
    // Every comment is in the state and has a bool question of its own.
    const { state, questions } = h.classifyCalls[0]!.context;
    expect(JSON.stringify(state)).toContain(BODIES[0]!);
    expect(JSON.stringify(state)).toContain(BODIES[1]!);
    expect(Object.values(questions).map((q) => q.type)).toEqual([
      "bool",
      "bool",
    ]);
    expect(h.chatCalls()).toBe(0);
    expect(logs.join("\n")).toMatch(/faux\/jev-1\.13.*10 tokens.*\$0\.0010/);
  });

  test("falls back to the main chat model when the provider has no jev", async () => {
    const h = await harness({
      chat: [fauxAssistantMessage("[true, false]")],
    });
    const verdicts = await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([true, false]);
    expect(h.chatCalls()).toBe(1);
    expect(h.classifyCalls).toHaveLength(0);
  });

  test("uses a classifier named in classify_model", async () => {
    const h = await harness({ classifiers: ["jev-1.13", "kev-4b"] });
    await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      classifyModel: `${PROVIDER}/kev-4b`,
      modelRuntime: h.modelRuntime,
    });
    expect(h.classifyCalls.map((c) => c.model)).toEqual(["kev-4b"]);
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

  test("the api_key input authenticates the main model's provider", async () => {
    delete process.env.FAUX_TEST_API_KEY;
    const h = await harness({ classifiers: ["jev-1.13"] });
    const verdicts = await classifyComments(BODIES, {
      model: `${PROVIDER}/chat-model`,
      apiKey: "key-from-the-input",
      modelRuntime: h.modelRuntime,
    });
    expect(verdicts).toEqual([true, true]);
    expect(h.keysSeen).toEqual(["key-from-the-input"]);
  });

  describe("returns null, so every comment is posted", () => {
    test("when no model is set", async () => {
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
      expect(logs.join("\n")).toContain("::warning::");
      expect(h.classifyCalls).toHaveLength(0);
    });

    test("when the provider has no credentials", async () => {
      delete process.env.FAUX_TEST_API_KEY;
      const h = await harness({ classifiers: ["jev-1.13"] });
      expect(
        await classifyComments(BODIES, {
          model: `${PROVIDER}/chat-model`,
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
    });

    test("when the classifier stops with an error", async () => {
      const h = await harness({
        classifiers: ["jev-1.13"],
        classify: () => ({
          stopReason: "error",
          errorMessage: "rate limited",
          answers: {},
        }),
      });
      expect(
        await classifyComments(BODIES, {
          model: `${PROVIDER}/chat-model`,
          modelRuntime: h.modelRuntime,
        }),
      ).toBeNull();
      expect(logs.join("\n")).toContain("rate limited");
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
          model: `${PROVIDER}/chat-model`,
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
