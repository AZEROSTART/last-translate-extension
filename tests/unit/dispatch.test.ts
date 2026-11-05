import { it, expect, vi } from "vitest";
import { handleTranslate, handleChat, createDeps, createSingleSegmentPrefixStripper } from "../../src/background/dispatch";
import type { Deps } from "../../src/background/dispatch";
import type { CompletionRequest, CompletionResult, ProviderAdapter } from "../../src/providers";
import { ProviderError } from "../../src/shared/errors";
import { buildCacheKey } from "../../src/background/cache";
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
  theme: "system",
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

it("returns cached results without calling the provider", async () => {
  const { d, sent, send } = deps({ cache: { get: async () => "缓存的译文", put: async () => {} } });
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

it("builds the cache key from text, target lang, provider, model and prompt version", async () => {
  const get = vi.fn<(key: string) => Promise<string | undefined>>(async () => undefined);
  const { d } = deps({ cache: { get, put: vi.fn(async () => {}) } });
  await handleTranslate(d, { type: "translate", requestId: "r10", tabId: 1, items: items(1) }, () => {});
  const expected = await buildCacheKey({
    sourceText: "hello 1",
    targetLang: "zh-CN",
    providerConfigId: "a",
    modelId: "m",
    promptVersion: "v1",
  });
  expect(get.mock.calls[0][0]).toBe(expected);
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
