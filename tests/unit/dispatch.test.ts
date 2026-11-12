import { it, expect, vi, afterEach } from "vitest";
import {
  handleTranslate,
  handleChat,
  createAnnotatedStreamFilter,
  createDeps,
  createSingleSegmentPrefixStripper,
  isContextLengthError,
  penalizedRps,
} from "../../src/background/dispatch";
import type { Deps } from "../../src/background/dispatch";
import type { CompletionRequest, CompletionResult, ProviderAdapter } from "../../src/providers";
import { ProviderError } from "../../src/shared/errors";
import { buildCacheKey } from "../../src/background/cache";
import type { CachedTranslation } from "../../src/background/cache";
import { DEFAULT_SETTINGS } from "../../src/shared/storage";
import { promptVersionFor } from "../../src/shared/prompt";
import type { ProviderConfig, Settings } from "../../src/shared/types";

const settings: Settings = {
  providers: [{ id: "a", name: "A", kind: "custom", baseURL: "https://x", apiKey: "k", model: "m", createdAt: 1 }],
  activeProviderId: "a",
  targetLang: "zh-CN",
  concurrency: 2,
  maxRPS: 100,
  temperature: 0,
  systemPrompt: "SYS",
  promptVersion: "v1",
  triggerMode: "shortcut",
  siteRules: {},
  glossaryEnabled: false,
  minParagraphLength: 10,
  contentOnly: true,
  theme: "system",
  learningLangs: ["en"],
  preference: { domain: "general", instructions: "" },
  mascot: { mode: "rotate", enabledIds: [], animations: true },
};

function fakeAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: "custom",
    listModels: vi.fn(async () => []),
    complete: vi.fn(async () => ({ text: "[1] 你好" })),
    streamCompletion: vi.fn(async function* () {
      yield "[1] 你好";
    }),
    ...over,
  };
}

function deps(over: Partial<Deps> = {}) {
  const sent: any[] = [];
  const d = createDeps({
    getSettings: async () => settings,
    cache: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    adapter: fakeAdapter(),
    ...over,
  });
  return { d, sent, send: (m: any) => sent.push(m) };
}

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p_${i + 1}`, text: `hello ${i + 1}`, hash: `h${i + 1}` }));

afterEach(() => {
  vi.useRealTimers();
});

it("returns cached results without calling the provider", async () => {
  const { d, sent, send } = deps({
    cache: { get: async () => ({ text: "缓存的译文", glossary: [] }), put: async () => {} },
  });
  await handleTranslate(d, { type: "translate", requestId: "r1", tabId: 1, items: items(1) }, send);
  expect(d.adapter.complete).not.toHaveBeenCalled();
  expect(d.adapter.streamCompletion).not.toHaveBeenCalled();
  expect(sent).toContainEqual({ type: "result", requestId: "r1", items: [{ id: "p_1", text: "缓存的译文" }] });
});

it("streams a single-segment group and emits stripped delta, result, finish", async () => {
  const { d, sent, send } = deps();
  await handleTranslate(d, { type: "translate", requestId: "r2", tabId: 1, items: items(1) }, send);
  expect(sent).toEqual([
    { type: "delta", requestId: "r2", id: "p_1", text: "你好" },
    { type: "result", requestId: "r2", items: [{ id: "p_1", text: "你好" }] },
    { type: "finish", requestId: "r2" },
  ]);
});

it("strips the [1] prefix from a single chunk", () => {
  const s = createSingleSegmentPrefixStripper();
  expect(s.push("[1] 你好")).toBe("你好");
  expect(s.finish()).toBe("");
});

it("strips a [1] prefix split across chunks", () => {
  const s = createSingleSegmentPrefixStripper();
  expect(s.push("[")).toBe("");
  expect(s.push("1] ")).toBe("");
  expect(s.push("你好")).toBe("你好");
  expect(s.finish()).toBe("");
});

it("leaves text that does not start with [1] untouched", () => {
  const s = createSingleSegmentPrefixStripper();
  expect(s.push("你好")).toBe("你好");
  expect(s.finish()).toBe("");
});

it("flushes a diverging partial prefix instead of swallowing text", () => {
  const s = createSingleSegmentPrefixStripper();
  expect(s.push("[2] 你好")).toBe("[2] 你好");
  expect(s.finish()).toBe("");
});

it("strips a prefix split across stream chunks in delta and result", async () => {
  const streamCompletion = vi.fn(async function* () {
    yield "[";
    yield "1] ";
    yield "你";
    yield "好";
  });
  const { d, sent, send } = deps({ adapter: fakeAdapter({ streamCompletion }) });
  await handleTranslate(d, { type: "translate", requestId: "rs", tabId: 1, items: items(1) }, send);
  expect(sent.map((m) => m.type)).toEqual(["delta", "delta", "result", "finish"]);
  expect(sent.find((m) => m.type === "result").items).toEqual([{ id: "p_1", text: "你好" }]);
});

it("streams only translation text and returns glossary notes", async () => {
  const streamCompletion = vi.fn(async function* () {
    yield "[1] 小工具";
    yield "比制造者存在得更久。\n<<<ILMT_";
    yield 'GLOSSARY>>>\n{"1":[{"surface":"outlive","meaning":"比……存在得更久"}]}';
  });
  const put = vi.fn(async () => {});
  const settingsWithGlossary = { ...settings, glossaryEnabled: true };
  const { d, sent, send } = deps({
    getSettings: async () => settingsWithGlossary,
    adapter: fakeAdapter({ streamCompletion }),
    cache: { get: async () => undefined, put },
  });
  await handleTranslate(
    d,
    {
      type: "translate",
      requestId: "rg1",
      tabId: 1,
      items: [{ id: "p_1", text: "Small tools outlive.", hash: "h" }],
    },
    send,
  );

  expect(sent.filter((m) => m.type === "delta").map((m) => m.text)).toEqual([
    "小工具",
    "比制造者存在得更久。\n",
  ]);
  expect(sent.find((m) => m.type === "result").items).toEqual([
    {
      id: "p_1",
      text: "小工具比制造者存在得更久。\n",
      glossary: [{ surface: "outlive", meaning: "比……存在得更久" }],
    },
  ]);
  expect(put).toHaveBeenCalledWith(
    expect.any(String),
    {
      text: "小工具比制造者存在得更久。\n",
      glossary: [{ surface: "outlive", meaning: "比……存在得更久" }],
    },
    { modelId: "m" },
  );
});

it("returns glossary notes for a multi-segment group", async () => {
  const complete = vi.fn(async () => ({
    text:
      "[1] 甲\n[2] 乙\n<<<ILMT_GLOSSARY>>>\n" +
      JSON.stringify({ "2": [{ surface: "hello 2", meaning: "你好二" }] }),
  }));
  const { d, sent, send } = deps({
    getSettings: async () => ({ ...settings, glossaryEnabled: true }),
    adapter: fakeAdapter({ complete }),
    cache: { get: async () => undefined, put: vi.fn(async () => {}) },
  });
  await handleTranslate(d, { type: "translate", requestId: "rg1b", tabId: 1, items: items(2) }, send);

  expect(sent.find((m) => m.type === "result").items).toEqual([
    { id: "p_1", text: "甲" },
    { id: "p_2", text: "乙", glossary: [{ surface: "hello 2", meaning: "你好二" }] },
  ]);
});

it("returns translation without notes when the glossary JSON is broken", async () => {
  const settingsWithGlossary = { ...settings, glossaryEnabled: true };
  const complete = vi.fn(async () => ({
    text: "[1] 甲\n[2] 乙\n<<<ILMT_GLOSSARY>>>\n{broken",
  }));
  const { d, sent, send } = deps({
    getSettings: async () => settingsWithGlossary,
    adapter: fakeAdapter({ complete }),
    cache: { get: async () => undefined, put: vi.fn(async () => {}) },
  });
  await handleTranslate(d, { type: "translate", requestId: "rg2", tabId: 1, items: items(2) }, send);

  expect(sent.find((m) => m.type === "result").items).toEqual([
    { id: "p_1", text: "甲" },
    { id: "p_2", text: "乙" },
  ]);
});

it("uses cached glossary without calling the provider", async () => {
  const cached = { text: "缓存的译文", glossary: [{ surface: "hello 1", meaning: "缓存" }] };
  const { d, sent, send } = deps({
    getSettings: async () => ({ ...settings, glossaryEnabled: true }),
    cache: { get: async () => cached, put: vi.fn(async () => {}) },
  });
  await handleTranslate(d, { type: "translate", requestId: "rg3", tabId: 1, items: items(1) }, send);

  expect(d.adapter.complete).not.toHaveBeenCalled();
  expect(d.adapter.streamCompletion).not.toHaveBeenCalled();
  expect(sent.find((m) => m.type === "result").items).toEqual([
    { id: "p_1", text: "缓存的译文", glossary: cached.glossary },
  ]);
});

it("changes the cache key when glossary is enabled", async () => {
  const keys: string[] = [];
  const cache = {
    get: async (key: string) => {
      keys.push(key);
      return undefined;
    },
    put: async () => {},
  };
  const off = deps({
    getSettings: async () => ({ ...settings, glossaryEnabled: false }),
    cache,
  });
  await handleTranslate(
    off.d,
    { type: "translate", requestId: "rg4", tabId: 1, items: items(1) },
    off.send,
  );
  const on = deps({
    getSettings: async () => ({ ...settings, glossaryEnabled: true }),
    cache,
  });
  await handleTranslate(
    on.d,
    { type: "translate", requestId: "rg5", tabId: 1, items: items(1) },
    on.send,
  );
  expect(keys[0]).not.toBe(keys[1]);
});

it("strips a glossary marker split across stream chunks", () => {
  const filter = createAnnotatedStreamFilter();
  expect(filter.push("[1] 你")).toBe("你");
  expect(filter.push("好\n<<<ILMT_")).toBe("好\n");
  expect(filter.push('GLOSSARY>>>\n{"1":[{"surface":"好","meaning":"good"}]}')).toBe("");
  expect(filter.finish()).toEqual({
    text: "你好\n",
    notesRaw: '{"1":[{"surface":"好","meaning":"good"}]}',
  });
});

it("emits error with the affected ids when the model returns a bad shape", async () => {
  const { d, sent, send } = deps({ adapter: fakeAdapter({ complete: vi.fn(async () => ({ text: "garbage" })) }) });
  await handleTranslate(d, { type: "translate", requestId: "r3", tabId: 1, items: items(2) }, send);
  const err = sent.find((m) => m.type === "error");
  expect(err.ids).toEqual(["p_1", "p_2"]);
  expect(err.code).toBe("bad_response");
  expect(err.retryable).toBe(false);
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "r3" });
});

it("rejects messages whose sender is not this extension", async () => {
  const { d } = deps();
  expect(d.isTrustedSender({ id: "someone-else" } as any)).toBe(false);
});

it("emits a bad_response error and never calls the adapter when no provider is active", async () => {
  const { d, sent, send } = deps({ getSettings: async () => ({ ...settings, providers: [], activeProviderId: "missing" }) });
  await handleTranslate(d, { type: "translate", requestId: "r5", tabId: 1, items: items(1) }, send);
  const err = sent.find((m) => m.type === "error");
  expect(err.code).toBe("bad_response");
  expect(err.message).toBe("未选择模型配置");
  expect(err.retryable).toBe(false);
  expect(err.ids).toEqual(["p_1"]);
  expect(d.adapter.complete).not.toHaveBeenCalled();
  expect(d.adapter.streamCompletion).not.toHaveBeenCalled();
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "r5" });
});

it("fails a group whose parsed translation is empty instead of rendering blank", async () => {
  const { d, sent, send } = deps({ adapter: fakeAdapter({ complete: vi.fn(async () => ({ text: "[1] 甲\n[2]" })) }) });
  await handleTranslate(d, { type: "translate", requestId: "r6", tabId: 1, items: items(2) }, send);
  const err = sent.find((m) => m.type === "error");
  expect(err.code).toBe("bad_response");
  expect(err.retryable).toBe(false);
  expect(err.ids).toEqual(["p_1", "p_2"]);
  expect(sent.some((m) => m.type === "result")).toBe(false);
});

it("retries retryable failures at most twice with 1s then 3s backoff", async () => {
  const sleeps: number[] = [];
  const complete = vi
    .fn()
    .mockRejectedValueOnce(new ProviderError("rate_limit", "busy", { retryable: true }))
    .mockRejectedValueOnce(new ProviderError("network", "net", { retryable: true }))
    .mockResolvedValue({ text: "[1] 甲\n[2] 乙" });
  const { d, sent, send } = deps({
    adapter: fakeAdapter({ complete }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await handleTranslate(d, { type: "translate", requestId: "r7", tabId: 1, items: items(2) }, send);
  expect(complete).toHaveBeenCalledTimes(3);
  expect(sleeps).toEqual([1000, 3000]);
  expect(sent).toContainEqual({ type: "result", requestId: "r7", items: [{ id: "p_1", text: "甲" }, { id: "p_2", text: "乙" }] });
});

it("does not retry non-retryable failures", async () => {
  const complete = vi.fn().mockRejectedValue(new ProviderError("auth", "bad key", { retryable: false }));
  const { d, sent, send } = deps({ adapter: fakeAdapter({ complete }) });
  await handleTranslate(d, { type: "translate", requestId: "r8", tabId: 1, items: items(2) }, send);
  expect(complete).toHaveBeenCalledTimes(1);
  const err = sent.find((m) => m.type === "error");
  expect(err.code).toBe("auth");
  expect(err.retryable).toBe(false);
});

it("translates a multi-segment group, caches each item, and uses provider overrides", async () => {
  const put = vi.fn(async () => {});
  const complete = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => Promise<CompletionResult>>(async () => ({
    text: "[1] 甲\n[2] 乙",
  }));
  const provider = { ...settings.providers[0], overrides: { systemPrompt: "OVERRIDE", temperature: 0.7 } };
  const { d, sent, send } = deps({
    getSettings: async () => ({ ...settings, providers: [provider] }),
    adapter: fakeAdapter({ complete }),
    cache: { get: vi.fn(async () => undefined), put },
  });
  await handleTranslate(d, { type: "translate", requestId: "r9", tabId: 1, items: items(2) }, send);
  expect(complete).toHaveBeenCalledTimes(1);
  const req = complete.mock.calls[0][1];
  expect(req.temperature).toBe(0.7);
  expect(req.messages[0].content).toBe("OVERRIDE");
  expect(put).toHaveBeenCalledTimes(2);
  expect(sent).toContainEqual({ type: "result", requestId: "r9", items: [{ id: "p_1", text: "甲" }, { id: "p_2", text: "乙" }] });
});

it("builds the cache key from text, target lang, provider, model and effective prompt version", async () => {
  const get = vi.fn<(key: string) => Promise<CachedTranslation | undefined>>(async () => undefined);
  const { d } = deps({ cache: { get, put: vi.fn(async () => {}) } });
  await handleTranslate(d, { type: "translate", requestId: "r10", tabId: 1, items: items(1) }, () => {});
  const expected = await buildCacheKey({
    sourceText: "hello 1",
    targetLang: "zh-CN",
    providerConfigId: "a",
    modelId: "m",
    promptVersion: await promptVersionFor("SYS"),
  });
  expect(get.mock.calls[0][0]).toBe(expected);
});

it("keys the cache by each provider's effective systemPrompt override", async () => {
  const keys: string[] = [];
  let override = "OVERRIDE_A";
  const provider = (): ProviderConfig => ({
    ...settings.providers[0],
    overrides: { systemPrompt: override },
  });
  const { d } = deps({
    getSettings: async () => ({ ...settings, providers: [provider()] }),
    cache: {
      get: async (key: string) => {
        keys.push(key);
        return undefined;
      },
      put: async () => {},
    },
  });

  await handleTranslate(d, { type: "translate", requestId: "r12", tabId: 1, items: items(1) }, () => {});
  override = "OVERRIDE_B";
  await handleTranslate(d, { type: "translate", requestId: "r13", tabId: 1, items: items(1) }, () => {});

  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[0]).not.toBe(
    await buildCacheKey({
      sourceText: "hello 1",
      targetLang: "zh-CN",
      providerConfigId: "a",
      modelId: "m",
      promptVersion: settings.promptVersion,
    }),
  );
});

it("falls back to the built-in prompt when the global systemPrompt is blank", async () => {
  const complete = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => Promise<CompletionResult>>(
    async () => ({ text: "[1] 甲\n[2] 乙" }),
  );
  const { d } = deps({
    getSettings: async () => ({ ...settings, systemPrompt: "   " }),
    adapter: fakeAdapter({ complete }),
  });

  await handleTranslate(d, { type: "translate", requestId: "r14", tabId: 1, items: items(2) }, () => {});
  const req = complete.mock.calls[0][1];
  expect(req.messages[0].content).toBe(
    DEFAULT_SETTINGS.systemPrompt.replace("{{targetLang}}", "zh-CN"),
  );
});

it("clamps concurrency and RPS to their ranges, honoring provider overrides", async () => {
  const overrides = { concurrency: 5, maxRPS: 7 };
  const provider = { ...settings.providers[0], overrides };
  const { d } = deps({ getSettings: async () => ({ ...settings, concurrency: 99, maxRPS: 999, providers: [provider] }) });
  const spy = vi.spyOn(d.queue, "setLimits");
  await handleTranslate(d, { type: "translate", requestId: "r11", tabId: 1, items: items(1) }, () => {});
  expect(spy).toHaveBeenCalledWith(5, 7);
  spy.mockRestore();
});

it("streams a chat reply and emits delta then finish", async () => {
  const { d, sent, send } = deps({
    adapter: fakeAdapter({ streamCompletion: vi.fn(async function* () { yield "你"; yield "好"; }) }),
  });
  await handleChat(
    d,
    {
      type: "chat",
      requestId: "c1",
      sessionId: "s1",
      messages: [{ role: "user", content: "你好" }],
      context: { pageUrl: "https://x", title: "T", quotes: [], recentParagraphs: [] },
    },
    send,
    1,
  );
  expect(sent.map((m) => m.type)).toEqual(["delta", "delta", "finish"]);
});

// ---------------------------------------------------------------------------
// Settings/cache failures must never leave a request inflight.
// ---------------------------------------------------------------------------

it("reports a settings read failure and finishes instead of aborting silently", async () => {
  const { d, sent, send } = deps({
    getSettings: async () => {
      throw new Error("IndexedDB is unavailable");
    },
  });
  await handleTranslate(d, { type: "translate", requestId: "rs1", tabId: 1, items: items(2) }, send);

  expect(sent).toEqual([
    {
      type: "error",
      requestId: "rs1",
      code: "bad_response",
      message: "读取设置失败，请重试",
      retryable: false,
      ids: ["p_1", "p_2"],
    },
    { type: "finish", requestId: "rs1" },
  ]);
  expect(d.adapter.complete).not.toHaveBeenCalled();
  expect(d.adapter.streamCompletion).not.toHaveBeenCalled();
});

it("reports a settings read failure to the chat panel and finishes", async () => {
  const { d, sent, send } = deps({
    getSettings: async () => {
      throw new Error("storage broke");
    },
  });
  await handleChat(
    d,
    {
      type: "chat",
      requestId: "cs1",
      sessionId: "s1",
      messages: [{ role: "user", content: "你好" }],
      context: { pageUrl: "https://x", title: "T", quotes: [], recentParagraphs: [] },
    },
    send,
    1,
  );

  expect(sent).toEqual([
    { type: "error", requestId: "cs1", code: "bad_response", message: "读取设置失败，请重试", retryable: false },
    { type: "finish", requestId: "cs1" },
  ]);
  expect(d.adapter.streamCompletion).not.toHaveBeenCalled();
});

it("treats a cache read failure as a miss and still translates", async () => {
  const { d, sent, send } = deps({
    cache: {
      get: vi.fn(async () => {
        throw new Error("IndexedDB read failed");
      }),
      put: vi.fn(async () => {}),
    },
  });
  await handleTranslate(d, { type: "translate", requestId: "rc1", tabId: 1, items: items(1) }, send);

  expect(d.adapter.streamCompletion).toHaveBeenCalledTimes(1);
  expect(sent).toContainEqual({ type: "result", requestId: "rc1", items: [{ id: "p_1", text: "你好" }] });
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "rc1" });
});

it("treats a cache write failure as non-fatal and still reports the result", async () => {
  const { d, sent, send } = deps({
    cache: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new Error("IndexedDB write failed");
      }),
    },
  });
  await handleTranslate(d, { type: "translate", requestId: "rc2", tabId: 1, items: items(1) }, send);

  expect(sent).toContainEqual({ type: "result", requestId: "rc2", items: [{ id: "p_1", text: "你好" }] });
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "rc2" });
});

it("sends exactly one finish when every group fails", async () => {
  const rejection = () => new ProviderError("auth", "bad key", { retryable: false });
  const complete = vi.fn(async () => {
    throw rejection();
  });
  const streamCompletion = vi.fn(async function* (): AsyncGenerator<string> {
    throw rejection();
  });
  const { d, sent, send } = deps({ adapter: fakeAdapter({ complete, streamCompletion }) });

  // 21 items form two groups (the grouping cap is 20).
  await handleTranslate(d, { type: "translate", requestId: "rg1", tabId: 1, items: items(21) }, send);

  expect(sent.filter((m) => m.type === "error")).toHaveLength(2);
  expect(sent.filter((m) => m.type === "finish")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Chat timeout policy (spec §8.9: no total timeout) and prompt layout (§12).
// ---------------------------------------------------------------------------

it("requests no total timeout for chat and keeps the default for translation", async () => {
  const chatStream = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => AsyncGenerator<string>>(async function* () {});
  const { d: chatDeps, send: chatSend } = deps({ adapter: fakeAdapter({ streamCompletion: chatStream }) });
  await handleChat(
    chatDeps,
    {
      type: "chat",
      requestId: "ct1",
      sessionId: "s1",
      messages: [{ role: "user", content: "你好" }],
      context: { pageUrl: "https://x", title: "T", quotes: [], recentParagraphs: [] },
    },
    chatSend,
    1,
  );
  expect(chatStream.mock.calls[0][1].totalTimeoutMs).toBeNull();

  const translateStream = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => AsyncGenerator<string>>(async function* () {
    yield "[1] 你好";
  });
  const { d: translateDeps, send: translateSend } = deps({ adapter: fakeAdapter({ streamCompletion: translateStream }) });
  await handleTranslate(
    translateDeps,
    { type: "translate", requestId: "tt1", tabId: 1, items: items(1) },
    translateSend,
  );
  expect(translateStream.mock.calls[0][1].totalTimeoutMs).toBeUndefined();
});

it("threads the chat thinking flag into the provider request", async () => {
  const chatStream = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => AsyncGenerator<string>>(
    async function* () {},
  );
  const { d, send } = deps({ adapter: fakeAdapter({ streamCompletion: chatStream }) });

  await handleChat(
    d,
    {
      type: "chat",
      requestId: "ct1",
      sessionId: "s1",
      messages: [{ role: "user", content: "你好" }],
      context: { pageUrl: "https://x", title: "T", quotes: [], recentParagraphs: [] },
      thinking: true,
    },
    send,
    1,
  );

  expect(chatStream.mock.calls[0][1].thinking).toBe(true);
});

it("leaves thinking unset for translation requests", async () => {
  const complete = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => Promise<CompletionResult>>(
    async () => ({ text: "[1] 甲\n[2] 乙" }),
  );
  const { d } = deps({ adapter: fakeAdapter({ complete }) });

  await handleTranslate(d, { type: "translate", requestId: "tt1", tabId: 1, items: items(2) }, () => {});
  expect(complete.mock.calls[0][1].thinking).toBeUndefined();
});

it("keeps page context out of the system prompt and inside the user message", async () => {
  const streamCompletion = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => AsyncGenerator<string>>(async function* () {
    yield "好的";
  });
  const { d, send } = deps({ adapter: fakeAdapter({ streamCompletion }) });

  await handleChat(
    d,
    {
      type: "chat",
      requestId: "cp1",
      sessionId: "s1",
      messages: [{ role: "user", content: "请解释这句话" }],
      context: {
        pageUrl: "https://example.com/page",
        title: "示例页面标题",
        quotes: ["引用文字"],
        recentParagraphs: [{ source: "原文段落", translation: "译文段落" }],
      },
    },
    send,
    1,
  );

  const request = streamCompletion.mock.calls[0][1];
  const system = request.messages[0];
  const user = request.messages[1];

  expect(system.role).toBe("system");
  for (const secret of ["https://example.com/page", "示例页面标题", "引用文字", "原文段落", "译文段落"]) {
    expect(system.content).not.toContain(secret);
  }

  expect(user.role).toBe("user");
  expect(user.content).toContain("【页面上下文】");
  for (const contextText of ["https://example.com/page", "示例页面标题", "引用文字", "原文段落", "译文段落"]) {
    expect(user.content).toContain(contextText);
  }
  expect(user.content).toContain("【问题】");
  expect(user.content).toContain("请解释这句话");
  // The question must appear exactly once, not duplicated by the context block.
  expect(user.content.match(/请解释这句话/g)).toHaveLength(1);
});

it("renders selection-local context before recent paragraphs, never in the system prompt", async () => {
  const streamCompletion = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => AsyncGenerator<string>>(async function* () {
    yield "好的";
  });
  const { d, send } = deps({ adapter: fakeAdapter({ streamCompletion }) });

  await handleChat(
    d,
    {
      type: "chat",
      requestId: "cp-sel1",
      sessionId: "s1",
      messages: [{ role: "user", content: "请解释这句话" }],
      context: {
        pageUrl: "https://example.com/page",
        title: "示例页面标题",
        quotes: ["选中文字"],
        recentParagraphs: [{ source: "最近原文", translation: "最近译文" }],
        selectionContext: {
          heading: "章节标题",
          paragraph: "这是选中句所在的当前段落。",
          preceding: ["上一段第一句。", "上一段第二句。"],
        },
      },
    },
    send,
    1,
  );

  const request = streamCompletion.mock.calls[0][1];
  const system = request.messages[0];
  const user = request.messages[1];

  expect(system.role).toBe("system");
  for (const secret of ["章节标题", "这是选中句所在的当前段落。", "上一段第一句。", "上一段第二句。"]) {
    expect(system.content).not.toContain(secret);
  }

  expect(user.content).toContain("【选中位置上下文】");
  expect(user.content).toContain("所在标题：章节标题");
  expect(user.content).toContain("前面段落：");
  expect(user.content).toContain("- 上一段第一句。");
  expect(user.content).toContain("- 上一段第二句。");
  expect(user.content).toContain("当前段落：");
  expect(user.content).toContain("这是选中句所在的当前段落。");
  expect(user.content.indexOf("【选中位置上下文】")).toBeLessThan(user.content.indexOf("最近段落"));
  expect(user.content.match(/这是选中句所在的当前段落。/g)).toHaveLength(1);
});

it("attaches page context to the latest user turn without touching earlier turns", async () => {
  const streamCompletion = vi.fn<(cfg: ProviderConfig, req: CompletionRequest) => AsyncGenerator<string>>(async function* () {
    yield "好";
  });
  const { d, send } = deps({ adapter: fakeAdapter({ streamCompletion }) });

  await handleChat(
    d,
    {
      type: "chat",
      requestId: "cp2",
      sessionId: "s1",
      messages: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "第二问" },
      ],
      context: {
        pageUrl: "https://example.com/page",
        title: "示例页面标题",
        quotes: [],
        recentParagraphs: [],
      },
    },
    send,
    1,
  );

  const messages = streamCompletion.mock.calls[0][1].messages;
  expect(messages[1]).toEqual({ role: "user", content: "第一问" });
  expect(messages[2]).toEqual({ role: "assistant", content: "第一答" });
  expect(messages[3].content).toContain("【页面上下文】");
  expect(messages[3].content).toContain("第二问");
  expect(messages[3].content.match(/第二问/g)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Chat retries must not duplicate streamed deltas.
// ---------------------------------------------------------------------------

it("does not retry a chat stream that already emitted a delta", async () => {
  const streamCompletion = vi.fn(async function* () {
    yield "已经发出的内容";
    throw new ProviderError("network", "connection reset", { retryable: true });
  });
  const { d, sent, send } = deps({ adapter: fakeAdapter({ streamCompletion }) });

  await handleChat(
    d,
    {
      type: "chat",
      requestId: "cr1",
      sessionId: "s1",
      messages: [{ role: "user", content: "你好" }],
      context: { pageUrl: "https://x", title: "T", quotes: [], recentParagraphs: [] },
    },
    send,
    1,
  );

  expect(streamCompletion).toHaveBeenCalledTimes(1);
  expect(sent.filter((m) => m.type === "error")).toHaveLength(1);
  expect(sent.filter((m) => m.type === "delta")).toHaveLength(1);
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "cr1" });
});

it("still retries a chat stream that failed before emitting any delta", async () => {
  let calls = 0;
  const streamCompletion = vi.fn(async function* () {
    calls += 1;
    if (calls === 1) throw new ProviderError("network", "connection reset", { retryable: true });
    yield "好了";
  });
  const { d, sent, send } = deps({
    adapter: fakeAdapter({ streamCompletion }),
    sleep: async () => {},
  });

  await handleChat(
    d,
    {
      type: "chat",
      requestId: "cr2",
      sessionId: "s1",
      messages: [{ role: "user", content: "你好" }],
      context: { pageUrl: "https://x", title: "T", quotes: [], recentParagraphs: [] },
    },
    send,
    1,
  );

  expect(streamCompletion).toHaveBeenCalledTimes(2);
  expect(sent.filter((m) => m.type === "delta")).toHaveLength(1);
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "cr2" });
});

// ---------------------------------------------------------------------------
// Context-length failures split multi-item groups once (spec §11).
// ---------------------------------------------------------------------------

it("recognizes context-length provider failures", () => {
  expect(
    isContextLengthError(
      new ProviderError("bad_response", "This model's maximum context length is 4097 tokens", { status: 400 }),
    ),
  ).toBe(true);
  expect(isContextLengthError(new ProviderError("bad_response", "input is too long", { status: 413 }))).toBe(true);
  expect(isContextLengthError(new ProviderError("bad_response", "payload too large", { status: 413 }))).toBe(true);
  expect(isContextLengthError(new ProviderError("bad_response", "too many tokens", { status: 400 }))).toBe(true);
  expect(isContextLengthError(new ProviderError("bad_response", "invalid request", { status: 400 }))).toBe(false);
  expect(isContextLengthError(new ProviderError("auth", "context", { status: 401 }))).toBe(false);
  expect(isContextLengthError(new Error("context too long"))).toBe(false);
});

it("splits a multi-item group in half once on a context-length failure", async () => {
  const complete = vi.fn(async (_cfg: ProviderConfig, req: CompletionRequest) => {
    const lines = req.messages[1].content.trim().split("\n");
    if (lines.length === 4) {
      throw new ProviderError("bad_response", "maximum context length exceeded", { status: 400 });
    }
    return { text: "[1] 甲\n[2] 乙" };
  });
  const put = vi.fn(async () => {});
  const { d, sent, send } = deps({
    adapter: fakeAdapter({ complete }),
    cache: { get: vi.fn(async () => undefined), put },
  });

  await handleTranslate(d, { type: "translate", requestId: "rx1", tabId: 1, items: items(4) }, send);

  expect(complete).toHaveBeenCalledTimes(3);
  expect(complete.mock.calls[0][1].messages[1].content.trim().split("\n")).toHaveLength(4);
  expect(complete.mock.calls[1][1].messages[1].content.trim().split("\n")).toHaveLength(2);
  expect(complete.mock.calls[2][1].messages[1].content.trim().split("\n")).toHaveLength(2);
  // Both successful halves still cache every translated item.
  expect(put).toHaveBeenCalledTimes(4);

  const result = sent.find((m) => m.type === "result");
  expect(result.items).toEqual([
    { id: "p_1", text: "甲" },
    { id: "p_2", text: "乙" },
    { id: "p_3", text: "甲" },
    { id: "p_4", text: "乙" },
  ]);
  expect(sent.filter((m) => m.type === "finish")).toHaveLength(1);
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "rx1" });
});

it("enqueues split halves as separate queue tasks", async () => {
  const complete = vi.fn(async (_cfg: ProviderConfig, req: CompletionRequest) => {
    const lines = req.messages[1].content.trim().split("\n");
    if (lines.length === 4) {
      throw new ProviderError("bad_response", "maximum context length exceeded", { status: 400 });
    }
    return { text: "[1] 甲\n[2] 乙" };
  });
  const { d, send } = deps({ adapter: fakeAdapter({ complete }) });
  const enqueue = vi.spyOn(d.queue, "enqueue");

  await handleTranslate(d, { type: "translate", requestId: "rx4", tabId: 1, items: items(4) }, send);

  // Original group + two halves, each its own queue task.
  expect(enqueue).toHaveBeenCalledTimes(3);
  enqueue.mockRestore();
});

it("completes a split with a concurrency-1 queue", async () => {
  const complete = vi.fn(async (_cfg: ProviderConfig, req: CompletionRequest) => {
    const lines = req.messages[1].content.trim().split("\n");
    if (lines.length === 4) {
      throw new ProviderError("bad_response", "maximum context length exceeded", { status: 400 });
    }
    return { text: "[1] 甲\n[2] 乙" };
  });
  const { d, sent, send } = deps({
    getSettings: async () => ({ ...settings, concurrency: 1 }),
    adapter: fakeAdapter({ complete }),
  });

  await handleTranslate(d, { type: "translate", requestId: "rx5", tabId: 1, items: items(4) }, send);

  expect(complete).toHaveBeenCalledTimes(3);
  expect(sent.find((m) => m.type === "result").items).toHaveLength(4);
  expect(sent.filter((m) => m.type === "finish")).toHaveLength(1);
});

it("keeps a successful half when the other half is still too long", async () => {
  const complete = vi.fn(async (_cfg: ProviderConfig, req: CompletionRequest) => {
    const content = req.messages[1].content;
    const lines = content.trim().split("\n");
    if (lines.length === 4 || content.includes("hello 1")) {
      throw new ProviderError("bad_response", "maximum context length exceeded", { status: 400 });
    }
    return { text: "[1] 甲\n[2] 乙" };
  });
  const { d, sent, send } = deps({ adapter: fakeAdapter({ complete }) });

  await handleTranslate(d, { type: "translate", requestId: "rx6", tabId: 1, items: items(4) }, send);

  expect(complete).toHaveBeenCalledTimes(3);
  expect(sent.find((m) => m.type === "result").items).toEqual([
    { id: "p_3", text: "甲" },
    { id: "p_4", text: "乙" },
  ]);
  const errors = sent.filter((m) => m.type === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0].ids).toEqual(["p_1", "p_2"]);
  expect(sent.filter((m) => m.type === "finish")).toHaveLength(1);
});

it("does not split a single-item group and reports the context failure", async () => {
  const streamCompletion = vi.fn(async function* (): AsyncGenerator<string> {
    throw new ProviderError("bad_response", "context length exceeded", { status: 400 });
  });
  const { d, sent, send } = deps({ adapter: fakeAdapter({ streamCompletion }) });

  await handleTranslate(d, { type: "translate", requestId: "rx2", tabId: 1, items: items(1) }, send);

  expect(streamCompletion).toHaveBeenCalledTimes(1);
  const err = sent.find((m) => m.type === "error");
  expect(err.code).toBe("bad_response");
  expect(err.ids).toEqual(["p_1"]);
  expect(sent.at(-1)).toEqual({ type: "finish", requestId: "rx2" });
});

it("splits at most one level and fails each half that is still too long", async () => {
  const complete = vi.fn(async (_cfg: ProviderConfig, req: CompletionRequest) => {
    const lines = req.messages[1].content.trim().split("\n");
    if (lines.length >= 2) {
      throw new ProviderError("bad_response", "maximum context length exceeded", { status: 400 });
    }
    return { text: "[1] 甲" };
  });
  const { d, sent, send } = deps({ adapter: fakeAdapter({ complete }) });

  await handleTranslate(d, { type: "translate", requestId: "rx3", tabId: 1, items: items(4) }, send);

  // 4-item group + two 2-item halves = three calls, no further splitting.
  expect(complete).toHaveBeenCalledTimes(3);
  const errors = sent.filter((m) => m.type === "error");
  expect(errors).toHaveLength(2);
  expect(errors.map((m) => m.ids)).toEqual([
    ["p_1", "p_2"],
    ["p_3", "p_4"],
  ]);
  expect(sent.some((m) => m.type === "result")).toBe(false);
  expect(sent.filter((m) => m.type === "finish")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// 429 exhaustion halves the effective RPS for about a minute.
// ---------------------------------------------------------------------------

it("halves the effective RPS for 60s after a rate-limit group failure", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));

  const complete = vi.fn(async () => {
    throw new ProviderError("rate_limit", "busy", { retryable: true });
  });
  const { d } = deps({
    getSettings: async () => ({ ...settings, concurrency: 2, maxRPS: 10 }),
    adapter: fakeAdapter({ complete }),
    sleep: async () => {},
  });
  const setLimits = vi.spyOn(d.queue, "setLimits");

  const send1 = vi.fn();
  await handleTranslate(d, { type: "translate", requestId: "rl1", tabId: 1, items: items(2) }, send1);
  expect(setLimits.mock.calls).toEqual([[2, 10]]);

  setLimits.mockClear();
  const send2 = vi.fn();
  await handleTranslate(d, { type: "translate", requestId: "rl2", tabId: 1, items: items(2) }, send2);
  expect(setLimits.mock.calls).toEqual([[2, 5]]);

  await vi.advanceTimersByTimeAsync(60_001);

  setLimits.mockClear();
  const send3 = vi.fn();
  await handleTranslate(d, { type: "translate", requestId: "rl3", tabId: 1, items: items(2) }, send3);
  expect(setLimits.mock.calls).toEqual([[2, 10]]);
});

it("penalizedRps halves rates without ever dropping below 1", () => {
  expect(penalizedRps(10, false)).toBe(10);
  expect(penalizedRps(10, true)).toBe(5);
  expect(penalizedRps(3, true)).toBe(1);
  expect(penalizedRps(1, true)).toBe(1);
  expect(penalizedRps(0, true)).toBe(1);
});
