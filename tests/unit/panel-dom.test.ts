/**
 * DOM tests for the side-panel UI (`src/panel/main.ts`). `main.ts` is
 * side-effectful (it connects the `ilmt-chat` port and queries tabs on load),
 * so each test installs a fresh, complete `chrome` surface, re-imports the
 * module, and waits for the exposed `__ilmtPanel.ready` promise.
 */

import { it, expect, vi, beforeEach, afterEach } from "vitest";

type Listener = (...args: any[]) => void;

function makeStorage() {
  const store = new Map<string, unknown>();
  const clone = <T,>(value: T): T => structuredClone(value);
  const changeListeners: Listener[] = [];

  const emit = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): void => {
    for (const listener of changeListeners) listener(changes, "local");
  };

  const get = (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
    if (keys === null || keys === undefined) {
      return Promise.resolve(Object.fromEntries([...store].map(([k, v]) => [k, clone(v)])));
    }
    if (typeof keys === "string") {
      return Promise.resolve(store.has(keys) ? { [keys]: clone(store.get(keys)) } : {});
    }
    if (Array.isArray(keys)) {
      return Promise.resolve(
        Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, clone(store.get(k))])),
      );
    }
    return Promise.resolve(
      Object.fromEntries(Object.entries(keys).map(([k, fallback]) => [k, store.has(k) ? clone(store.get(k)) : clone(fallback)])),
    );
  };

  const set = (items: Record<string, unknown>): Promise<void> => {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: store.has(k) ? clone(store.get(k)) : undefined, newValue: clone(v) };
      store.set(k, clone(v));
    }
    emit(changes);
    return Promise.resolve();
  };

  const remove = (keys: string | string[]): Promise<void> => {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      changes[k] = { oldValue: store.has(k) ? clone(store.get(k)) : undefined, newValue: undefined };
      store.delete(k);
    }
    emit(changes);
    return Promise.resolve();
  };

  return { get, set, remove, _store: store, onChanged: { addListener: (cb: Listener) => changeListeners.push(cb) } };
}

interface ChromeOpts {
  pendingQuote?: unknown;
  history?: unknown;
  settings?: unknown;
  /** `null` makes `tabs.query` return no active tab. */
  tab?: { id: number; url: string; title: string } | null;
  /** `null` makes `tabs.get` reject, as if the quote's tab was closed. */
  tabGet?: { id: number; url: string; title: string } | null;
}

function installChrome(opts: ChromeOpts = {}) {
  const storage = makeStorage();
  if (opts.pendingQuote !== undefined) storage._store.set("chat.pendingQuote", opts.pendingQuote);
  if (opts.history !== undefined) storage._store.set("chat.history", opts.history);
  if (opts.settings !== undefined) storage._store.set("settings", opts.settings);

  const sent: unknown[] = [];
  const messageListeners: Listener[] = [];
  const disconnectListeners: Listener[] = [];
  const port = {
    postMessage: (m: unknown) => sent.push(m),
    onMessage: { addListener: (cb: Listener) => messageListeners.push(cb) },
    onDisconnect: { addListener: (cb: Listener) => disconnectListeners.push(cb) },
    disconnect: vi.fn(),
  };

  const activatedListeners: Listener[] = [];
  const updatedListeners: Listener[] = [];

  const chrome = {
    runtime: {
      id: "test-extension-id",
      connect: vi.fn(() => port),
      sendMessage: vi.fn(async () => undefined),
    },
    storage: { local: storage, onChanged: storage.onChanged },
    tabs: {
      query: vi.fn(async () =>
        opts.tab === null
          ? []
          : [opts.tab ?? { id: 1, url: "https://a.test/x", title: "A", windowId: 1 }],
      ),
      get: vi.fn(async (tabId: number) => {
        if (opts.tabGet === null) throw new Error("No tab with id");
        if (opts.tabGet !== undefined) return opts.tabGet;
        if (opts.tab === null) throw new Error("No tab with id");
        return opts.tab ?? { id: tabId, url: "https://a.test/x", title: "A", windowId: 1 };
      }),
      sendMessage: vi.fn(async () => ({ paragraphs: [] })),
      onActivated: { addListener: (cb: Listener) => activatedListeners.push(cb) },
      onUpdated: { addListener: (cb: Listener) => updatedListeners.push(cb) },
    },
  };
  (globalThis as any).chrome = chrome;

  return { chrome, storage, port, sent, messageListeners, disconnectListeners, activatedListeners, updatedListeners };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const originalChrome = (globalThis as any).chrome;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `<div id="root"></div>`;
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).chrome = originalChrome;
  delete (globalThis as any).__ilmtPanel;
  document.body.innerHTML = "";
  document.querySelectorAll("style[data-ilmt-panel]").forEach((el) => el.remove());
  delete document.documentElement.dataset.theme;
});

async function boot() {
  await import("../../src/panel/main");
  await (globalThis as any).__ilmtPanel.ready;
}

it("renders the fixed context note", async () => {
  installChrome();
  await boot();
  expect(document.querySelector(".context-note")?.textContent).toBe("参考选中段落与已翻译内容");
});

function settingsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: [
      { id: "p1", name: "Alpha", kind: "custom", baseURL: "https://a.test/v1", apiKey: "secret", model: "m1", createdAt: 1 },
      { id: "p2", name: "", kind: "custom", baseURL: "https://b.test/v1", apiKey: "secret", model: "m2", createdAt: 2 },
    ],
    activeProviderId: "p1",
    ...overrides,
  };
}

const deepseekProvider = {
  id: "ds",
  name: "DeepSeek",
  kind: "deepseek",
  baseURL: "https://api.deepseek.com",
  apiKey: "secret",
  appendV1: false,
  model: "deepseek-flash",
  createdAt: 3,
};

const customProvider = {
  id: "p1",
  name: "Alpha",
  kind: "custom",
  baseURL: "https://a.test/v1",
  apiKey: "secret",
  model: "m1",
  createdAt: 1,
};

it("renders the provider switcher with the active provider and its model", async () => {
  installChrome({ settings: settingsFixture() });
  await boot();

  const select = document.querySelector(".provider-select") as HTMLSelectElement;
  expect(select.hidden).toBe(false);
  expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
    ["p1", "Alpha"],
    ["p2", "p2"],
  ]);
  expect(select.value).toBe("p1");
  expect(document.querySelector(".provider-model")?.textContent).toBe("m1");
});

it("falls back to the first provider when no active provider is set", async () => {
  installChrome({ settings: settingsFixture({ activeProviderId: "" }) });
  await boot();

  const select = document.querySelector(".provider-select") as HTMLSelectElement;
  expect(select.value).toBe("p1");
  expect(document.querySelector(".provider-model")?.textContent).toBe("m1");
});

it("persists a provider change and updates the model label immediately", async () => {
  const { storage } = installChrome({ settings: settingsFixture() });
  await boot();

  const select = document.querySelector(".provider-select") as HTMLSelectElement;
  select.value = "p2";
  select.dispatchEvent(new Event("change"));
  expect(document.querySelector(".provider-model")?.textContent).toBe("m2");
  await flush();

  const saved = storage._store.get("settings") as { activeProviderId: string };
  expect(saved.activeProviderId).toBe("p2");
  expect(select.value).toBe("p2");
});

it("refreshes the provider switcher when settings change elsewhere", async () => {
  const { storage } = installChrome({ settings: settingsFixture() });
  await boot();

  await storage.set({
    settings: settingsFixture({
      providers: [
        { id: "p3", name: "Gamma", kind: "custom", baseURL: "https://c.test/v1", apiKey: "secret", model: "m3", createdAt: 3 },
      ],
      activeProviderId: "p3",
    }),
  });
  await flush();

  const select = document.querySelector(".provider-select") as HTMLSelectElement;
  expect([...select.options].map((option) => option.value)).toEqual(["p3"]);
  expect(select.value).toBe("p3");
  expect(document.querySelector(".provider-model")?.textContent).toBe("m3");
});

it("shows the empty provider state and opens the options page", async () => {
  const { chrome } = installChrome({ settings: settingsFixture({ providers: [], activeProviderId: "" }) });
  await boot();

  const select = document.querySelector(".provider-select") as HTMLSelectElement;
  expect(select.hidden).toBe(true);
  expect(document.querySelector(".provider-model")?.textContent).toBe("尚未配置模型");

  const settingsButton = document.querySelector(".provider-settings") as HTMLButtonElement;
  expect(settingsButton.hidden).toBe(false);
  settingsButton.click();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "open-options" });
});

it("shows the thinking toggle for DeepSeek and hides it for custom", async () => {
  installChrome({
    settings: settingsFixture({
      providers: [deepseekProvider],
      activeProviderId: "ds",
    }),
  });
  await boot();

  const toggle = document.querySelector(".thinking-toggle") as HTMLElement;
  const input = document.querySelector(".thinking-input") as HTMLInputElement;
  expect(toggle.hidden).toBe(false);
  expect(input.checked).toBe(false);

  await chrome.storage.local.set({
    settings: settingsFixture({
      providers: [customProvider],
      activeProviderId: "p1",
    }),
  });
  await flush();

  expect(toggle.hidden).toBe(true);
});

it("sends thinking false by default and true after enabling it", async () => {
  const { sent, messageListeners } = installChrome({
    settings: settingsFixture({
      providers: [deepseekProvider],
      activeProviderId: "ds",
    }),
  });
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "第一个问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const first = sent.find((m) => (m as { type?: string }).type === "chat") as {
    requestId: string;
    thinking: boolean;
  };
  expect(first.thinking).toBe(false);

  messageListeners[0]({ type: "finish", requestId: first.requestId });

  (document.querySelector(".thinking-input") as HTMLInputElement).click();
  input.value = "第二个问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    thinking: boolean;
  }>;
  expect(chats.at(-1)!.thinking).toBe(true);
});

it("prefills a follow-up pending quote and keeps its selection context when sent", async () => {
  const { storage, sent } = installChrome({
    pendingQuote: {
      text: "选中的文字",
      mode: "follow-up",
      tabId: 1,
      ts: 1,
      context: { paragraph: "选中的文字所在的段落。", preceding: [] },
    },
  });
  await boot();

  const chip = document.querySelector(".quote-chip") as HTMLElement;
  expect(chip.hidden).toBe(false);
  expect(chip.textContent).toContain("选中的文字");
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("选中的文字");
  expect(sent.some((m) => (m as { type?: string }).type === "chat")).toBe(false);
  expect(storage._store.has("chat.pendingQuote")).toBe(false);

  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as {
    context: { quotes: string[]; selectionContext?: unknown };
  };
  expect(chat.context.quotes).toEqual(["选中的文字"]);
  expect(chat.context.selectionContext).toEqual({
    paragraph: "选中的文字所在的段落。",
    preceding: [],
  });
});

it("auto-sends an explain pending quote on load without duplicating the user turn", async () => {
  const { storage, sent } = installChrome({
    pendingQuote: {
      text: "选中的文字",
      mode: "explain",
      tabId: 1,
      ts: 1,
      context: { heading: "章节", paragraph: "选中的文字所在的段落。", preceding: ["上一段。"] },
    },
  });
  await boot();
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    messages: Array<{ role: string; content: string }>;
    context: { quotes: string[]; selectionContext?: unknown };
  }>;
  expect(chats).toHaveLength(1);
  expect(chats[0].messages).toEqual([{ role: "user", content: "这是什么意思？" }]);
  expect(chats[0].context.quotes).toEqual(["选中的文字"]);
  expect(chats[0].context.selectionContext).toEqual({
    heading: "章节",
    paragraph: "选中的文字所在的段落。",
    preceding: ["上一段。"],
  });
  expect(document.querySelectorAll(".msg--user")).toHaveLength(1);
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  expect((document.querySelector(".quote-chip") as HTMLElement).hidden).toBe(true);
  expect(storage._store.has("chat.pendingQuote")).toBe(false);
});

it("auto-sends an explain quote using its tab when the initial active-tab query is empty", async () => {
  const { sent } = installChrome({
    tab: null,
    tabGet: { id: 1, url: "https://a.test/x", title: "A" },
    pendingQuote: { text: "选中的文字", mode: "explain", tabId: 1, ts: 1 },
  });
  await boot();
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    messages: Array<{ role: string; content: string }>;
    context: { quotes: string[] };
  }>;
  expect(chats).toHaveLength(1);
  expect(chats[0].messages).toEqual([{ role: "user", content: "这是什么意思？" }]);
  expect(chats[0].context.quotes).toEqual(["选中的文字"]);
});

it("prefills an explain quote when its tab can no longer be resolved", async () => {
  const { sent } = installChrome({
    tab: null,
    tabGet: null,
    pendingQuote: { text: "选中的文字", mode: "explain", tabId: 1, ts: 1 },
  });
  await boot();
  await flush();

  expect(sent.some((m) => (m as { type?: string }).type === "chat")).toBe(false);
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("选中的文字");
});

it("applies an explain quote pushed while the panel is already open", async () => {
  const { storage, sent } = installChrome();
  await boot();

  await storage.set({ "chat.pendingQuote": { text: "后来选中的文字", mode: "explain", tabId: 1, ts: 2 } });
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    messages: Array<{ role: string; content: string }>;
    context: { quotes: string[] };
  }>;
  expect(chats).toHaveLength(1);
  expect(chats[0].messages).toEqual([{ role: "user", content: "这是什么意思？" }]);
  expect(chats[0].context.quotes).toEqual(["后来选中的文字"]);
  expect(document.querySelectorAll(".msg--user")).toHaveLength(1);
  expect(storage._store.has("chat.pendingQuote")).toBe(false);
});

it("prefills a follow-up quote pushed while the panel is already open", async () => {
  const { storage, sent } = installChrome();
  await boot();

  await storage.set({ "chat.pendingQuote": { text: "后来选中的文字", mode: "follow-up", tabId: 1, ts: 2 } });
  await flush();

  expect((document.querySelector(".quote-chip") as HTMLElement).hidden).toBe(false);
  expect((document.querySelector(".quote-chip") as HTMLElement).textContent).toContain("后来选中的文字");
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("后来选中的文字");
  expect(sent.some((m) => (m as { type?: string }).type === "chat")).toBe(false);
  expect(storage._store.has("chat.pendingQuote")).toBe(false);
});

it("sends a chat request and appends streamed deltas to the assistant message", async () => {
  const { sent, messageListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "这是什么？";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as {
    requestId: string;
    messages: Array<{ role: string; content: string }>;
    context: { pageUrl: string };
  };
  expect(chat).toBeTruthy();
  expect(chat.messages).toEqual([{ role: "user", content: "这是什么？" }]);
  expect(chat.context.pageUrl).toBe("https://a.test/x");

  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "这是" });
  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "答案" });
  messageListeners[0]({ type: "finish", requestId: chat.requestId });

  const assistant = document.querySelector(".msg--assistant .msg-body") as HTMLElement;
  expect(assistant.textContent).toBe("这是答案");
});

it("passes the content script's recent translated paragraphs into the chat context", async () => {
  const { chrome, sent } = installChrome();
  (chrome.tabs.sendMessage as any).mockResolvedValue({
    paragraphs: [
      { source: "Hello", translation: "你好" },
      { source: "World", translation: "世界" },
    ],
  });
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "对比一下";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: "get-recent-translations" });
  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as {
    context: { recentParagraphs: unknown[] };
  };
  expect(chat.context.recentParagraphs).toEqual([
    { source: "Hello", translation: "你好" },
    { source: "World", translation: "世界" },
  ]);
});

it("uses an empty paragraph list when the content script rejects or returns junk", async () => {
  const { chrome, sent } = installChrome();
  (chrome.tabs.sendMessage as any).mockRejectedValue(new Error("no receiver"));
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "第一个问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const first = sent.find((m) => (m as { type?: string }).type === "chat") as {
    requestId: string;
    context: { recentParagraphs: unknown[] };
  };
  expect(first.context.recentParagraphs).toEqual([]);

  // Malformed payloads are treated the same as a failure.
  (chrome.tabs.sendMessage as any).mockResolvedValue({ paragraphs: [{ source: 42 }] });
  (document.querySelector(".composer-stop") as HTMLButtonElement).click();
  input.value = "第二个问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    context: { recentParagraphs: unknown[] };
  }>;
  expect(chats.at(-1)!.context.recentParagraphs).toEqual([]);
});

it("does not start a second chat while the recent-paragraph fetch is pending", async () => {
  const { chrome, sent } = installChrome();
  let resolveRecent: (value: unknown) => void = () => {};
  (chrome.tabs.sendMessage as any).mockReturnValue(
    new Promise((resolve) => {
      resolveRecent = resolve;
    }),
  );
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "只发一次";
  const send = document.querySelector(".composer-send") as HTMLButtonElement;
  send.click();
  input.value = "第二次点击";
  send.click();
  resolveRecent({ paragraphs: [] });
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat");
  expect(chats).toHaveLength(1);
});

it("aborts an in-flight request and keeps the partial answer with a resend action", async () => {
  const { sent, messageListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "部分" });

  (document.querySelector(".composer-stop") as HTMLButtonElement).click();
  expect(sent.some((m) => (m as { type?: string }).type === "abort")).toBe(true);

  const assistant = document.querySelector(".msg--assistant .msg-body") as HTMLElement;
  expect(assistant.textContent).toBe("部分");
  expect(document.querySelector(".error-block")?.textContent).toContain("已中断");
  expect(document.querySelector(".error-block")?.textContent).toContain("重新发送");
});

it("retries with one user turn, no stale assistant answer, and the selection context", async () => {
  const { sent, messageListeners } = installChrome({
    pendingQuote: {
      text: "引用文字",
      mode: "follow-up",
      tabId: 1,
      ts: 1,
      context: { paragraph: "引用文字所在的段落。", preceding: ["上一段。"] },
    },
  });
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "原问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const first = sent.find((m) => (m as { type?: string }).type === "chat") as {
    requestId: string;
    messages: Array<{ role: string; content: string }>;
    context: { quotes: string[]; selectionContext?: unknown };
  };
  expect(first.context.quotes).toEqual(["引用文字"]);
  expect(first.context.selectionContext).toEqual({
    paragraph: "引用文字所在的段落。",
    preceding: ["上一段。"],
  });
  messageListeners[0]({ type: "delta", requestId: first.requestId, text: "半截答案" });
  messageListeners[0]({
    type: "error",
    requestId: first.requestId,
    code: "network",
    message: "Network down",
    retryable: true,
  });

  expect(document.querySelectorAll(".msg--user")).toHaveLength(1);
  (document.querySelector(".error-retry") as HTMLButtonElement).click();
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    messages: Array<{ role: string; content: string; quote?: string }>;
    context: { quotes: string[]; selectionContext?: unknown };
  }>;
  expect(chats).toHaveLength(2);
  const retried = chats[1];
  expect(retried.messages.filter((m) => m.role === "user")).toHaveLength(1);
  expect(retried.messages.at(-1)).toMatchObject({ role: "user", content: "原问题" });
  expect(retried.context.quotes).toEqual(["引用文字"]);
  expect(retried.context.selectionContext).toEqual({
    paragraph: "引用文字所在的段落。",
    preceding: ["上一段。"],
  });
  const sessionUser = (globalThis as any).__ilmtPanel.session.messages.find(
    (message: { role: string }) => message.role === "user",
  );
  expect(sessionUser.quote).toBe("引用文字");
  expect(document.querySelectorAll(".msg--user")).toHaveLength(1);
  expect(document.querySelectorAll(".msg--assistant")).toHaveLength(1);
  expect(document.querySelector(".error-block")).toBeNull();
});

it.each([
  ["auth", "鉴权失败，请检查 API key"],
  ["rate_limit", "请求过于频繁，请稍后重试"],
  ["timeout", "请求超时"],
  ["network", "网络错误"],
  ["bad_response", "模型返回异常"],
  ["aborted", "已取消"],
  ["unknown", "请求失败"],
] as const)("shows Chinese copy for the %s error", async (code, copy) => {
  const { sent, messageListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({
    type: "error",
    requestId: chat.requestId,
    code,
    message: "raw English provider message",
    retryable: false,
  });

  const block = document.querySelector(".error-block") as HTMLElement;
  expect(block.textContent).toContain(copy);
  expect(block.textContent).not.toContain("raw English provider message");
});

it("invalidates the pinned context when the same tab navigates to a new URL", async () => {
  const { chrome, sent, updatedListeners } = installChrome();
  await boot();

  // Same tab (id 1) now points at a different URL.
  (chrome.tabs.query as any).mockResolvedValue([
    { id: 1, url: "https://a.test/y", title: "B", windowId: 1 },
  ]);
  updatedListeners[0](
    1,
    { url: "https://a.test/y" },
    { id: 1, url: "https://a.test/y", title: "B", active: true, windowId: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const banner = document.querySelector(".banner") as HTMLElement;
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain("上下文已失效");
  expect(banner.textContent).toContain("针对新页面开新会话");

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "新页面的问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as {
    context: { pageUrl: string; title: string; recentParagraphs: unknown[] };
  };
  expect(chat).toBeTruthy();
  expect(chat.context.pageUrl).toBe("");
  expect(chat.context.title).toBe("");
  expect(chat.context.recentParagraphs).toEqual([]);
});

it("drops the selection context when the pinned page has navigated", async () => {
  const { chrome, sent, updatedListeners } = installChrome({
    pendingQuote: {
      text: "旧页面的引用",
      mode: "follow-up",
      tabId: 1,
      ts: 1,
      context: { paragraph: "旧页面的段落。", preceding: [] },
    },
  });
  await boot();

  (chrome.tabs.query as any).mockResolvedValue([
    { id: 1, url: "https://a.test/y", title: "B", windowId: 1 },
  ]);
  updatedListeners[0](
    1,
    { url: "https://a.test/y" },
    { id: 1, url: "https://a.test/y", title: "B", active: true, windowId: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "新页面的问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as {
    context: { pageUrl: string; title: string; recentParagraphs: unknown[]; selectionContext?: unknown };
  };
  expect(chat.context.pageUrl).toBe("");
  expect(chat.context.title).toBe("");
  expect(chat.context.recentParagraphs).toEqual([]);
  expect(chat.context.selectionContext).toBeUndefined();
});

it("starts a fresh session pinned to the new page from the stale banner", async () => {
  const { chrome, sent, messageListeners, updatedListeners } = installChrome();
  await boot();

  const oldSessionId = (globalThis as any).__ilmtPanel.session.id as string;

  // Give the original session real history so it is persisted and findable by
  // `tabId`; this is the path where the stale session used to be reused.
  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "旧页面的问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();
  const oldChat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({ type: "delta", requestId: oldChat.requestId, text: "旧答案" });
  messageListeners[0]({ type: "finish", requestId: oldChat.requestId });

  // Same tab (id 1) now points at a different URL.
  (chrome.tabs.query as any).mockResolvedValue([
    { id: 1, url: "https://a.test/y", title: "B", windowId: 1 },
  ]);
  updatedListeners[0](
    1,
    { url: "https://a.test/y" },
    { id: 1, url: "https://a.test/y", title: "B", active: true, windowId: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const banner = document.querySelector(".banner") as HTMLElement;
  expect(banner.hidden).toBe(false);
  (document.querySelector(".banner-action") as HTMLButtonElement).click();

  // A new session, not the stale one, pinned to the current page.
  const session = (globalThis as any).__ilmtPanel.session as {
    id: string;
    pageUrl: string;
    pageTitle: string;
    messages: unknown[];
  };
  expect(session.id).not.toBe(oldSessionId);
  expect(session.pageUrl).toBe("https://a.test/y");
  expect(session.pageTitle).toBe("B");
  expect(session.messages).toEqual([]);
  expect(banner.hidden).toBe(true);

  input.value = "新页面的问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.filter((m) => (m as { type?: string }).type === "chat").at(-1) as {
    context: { pageUrl: string; title: string; recentParagraphs: unknown[] };
  };
  expect(chat).toBeTruthy();
  expect(chat.context.pageUrl).toBe("https://a.test/y");
  expect(chat.context.title).toBe("B");
  expect(chat.context.recentParagraphs).toEqual([]);
});

it("treats a navigation to an unobservable URL as stale", async () => {
  const { chrome, sent, updatedListeners } = installChrome();
  await boot();

  // e.g. chrome://settings — the extension cannot read the URL, but the tab
  // really did navigate away from the pinned page.
  (chrome.tabs.query as any).mockResolvedValue([
    { id: 1, title: "设置", active: true, windowId: 1 },
  ]);
  updatedListeners[0](
    1,
    { status: "complete" },
    { id: 1, title: "设置", active: true, windowId: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const banner = document.querySelector(".banner") as HTMLElement;
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain("上下文已失效");

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "还能用吗";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as {
    context: { pageUrl: string; title: string };
  };
  expect(chat).toBeTruthy();
  expect(chat.context.pageUrl).toBe("");
  expect(chat.context.title).toBe("");
});

it("restores a persisted session when the same tab revisits the same URL", async () => {
  installChrome({
    tab: { id: 1, url: "https://a.test/x", title: "A" },
    history: [
      {
        id: "s_saved",
        tabId: 1,
        pageUrl: "https://a.test/x",
        pageTitle: "A",
        createdAt: 1,
        messages: [
          { role: "user", content: "旧问题", ts: 1 },
          { role: "assistant", content: "旧答案", ts: 2 },
        ],
      },
    ],
  });
  await boot();

  expect((globalThis as any).__ilmtPanel.session.id).toBe("s_saved");
  expect(document.querySelector(".msg-list")?.textContent).toContain("旧问题");
  expect(document.querySelector(".msg-list")?.textContent).toContain("旧答案");
});

it("does not switch sessions from the stale banner while a response is streaming", async () => {
  const { chrome, sent, messageListeners, updatedListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();
  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  const oldSessionId = (globalThis as any).__ilmtPanel.session.id as string;
  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "部分" });

  (chrome.tabs.query as any).mockResolvedValue([
    { id: 1, url: "https://a.test/y", title: "B", windowId: 1 },
  ]);
  updatedListeners[0](
    1,
    { url: "https://a.test/y" },
    { id: 1, url: "https://a.test/y", title: "B", active: true, windowId: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((document.querySelector(".banner") as HTMLElement).hidden).toBe(false);
  expect((document.querySelector(".banner-action") as HTMLButtonElement).disabled).toBe(true);
  (document.querySelector(".banner-action") as HTMLButtonElement).click();

  // The in-flight stream keeps its session; the answer is not dropped.
  expect((globalThis as any).__ilmtPanel.session.id).toBe(oldSessionId);
  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "继续" });
  messageListeners[0]({ type: "finish", requestId: chat.requestId });

  const assistant = document.querySelector(".msg--assistant .msg-body") as HTMLElement;
  expect(assistant.textContent).toBe("部分继续");
});

it("does not re-attach a stale session after a tab round-trip", async () => {
  const { chrome, sent, messageListeners, activatedListeners } = installChrome();
  await boot();

  // Persist the session pinned to https://a.test/x.
  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "旧问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();
  const oldChat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({ type: "delta", requestId: oldChat.requestId, text: "旧答案" });
  messageListeners[0]({ type: "finish", requestId: oldChat.requestId });
  const oldSessionId = (globalThis as any).__ilmtPanel.session.id as string;

  // Same tab navigates to /y, then the user starts a fresh session there.
  const tabY = { id: 1, url: "https://a.test/y", title: "B", active: true, windowId: 1 };
  (chrome.tabs.query as any).mockResolvedValue([tabY]);
  activatedListeners[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((document.querySelector(".banner") as HTMLElement).hidden).toBe(false);
  (document.querySelector(".banner-action") as HTMLButtonElement).click();
  expect((globalThis as any).__ilmtPanel.session.pageUrl).toBe("https://a.test/y");

  // Switch to another tab and back: the panel must not re-attach /x's session.
  (chrome.tabs.query as any).mockResolvedValue([
    { id: 2, url: "https://b.test/z", title: "C", active: true, windowId: 1 },
  ]);
  activatedListeners[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((document.querySelector(".banner") as HTMLElement).hidden).toBe(false);
  (document.querySelector(".banner-action") as HTMLButtonElement).click();

  (chrome.tabs.query as any).mockResolvedValue([tabY]);
  activatedListeners[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((document.querySelector(".banner") as HTMLElement).hidden).toBe(false);
  (document.querySelector(".banner-action") as HTMLButtonElement).click();

  const session = (globalThis as any).__ilmtPanel.session as { id: string; pageUrl: string };
  expect(session.id).not.toBe(oldSessionId);
  expect(session.pageUrl).toBe("https://a.test/y");
});

it("shows the interrupted copy and persists the partial answer when the port disconnects", async () => {
  const { storage, sent, messageListeners, disconnectListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "部分" });

  disconnectListeners[0]();

  const assistant = document.querySelector(".msg--assistant .msg-body") as HTMLElement;
  expect(assistant.textContent).toBe("部分");
  expect(document.querySelector(".error-block")?.textContent).toContain("已中断，重新发送");

  const history = storage._store.get("chat.history") as Array<{
    messages: Array<{ role: string; content: string }>;
  }>;
  expect(history).toHaveLength(1);
  expect(history[0].messages.at(-1)).toMatchObject({ role: "assistant", content: "部分" });
});

it("persists the session to chat.history after the assistant finishes", async () => {
  const { storage, sent, messageListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "答" });
  messageListeners[0]({ type: "finish", requestId: chat.requestId });

  const history = storage._store.get("chat.history") as Array<{
    tabId: number;
    messages: Array<{ role: string; content: string }>;
  }>;
  expect(history).toHaveLength(1);
  expect(history[0].tabId).toBe(1);
  expect(history[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(history[0].messages[1].content).toBe("答");
});

it("activates the quantum teal theme", async () => {
  installChrome();
  await boot();
  expect(document.documentElement.dataset.theme).toBe("quantum");
});

const explainQuote = {
  text: "outlive",
  mode: "explain",
  tabId: 1,
  ts: 1,
  termLang: "en",
  context: { paragraph: "Small tools often outlive their larger competitors.", preceding: [] },
};

function learnWordCalls(chrome: { runtime: { sendMessage: unknown } }): any[] {
  return (chrome.runtime.sendMessage as any).mock.calls
    .map((call: unknown[]) => call[0] as { type?: string })
    .filter((message: { type?: string }) => message?.type === "learn-word");
}

it("claims a short selected term after an explain answer finishes", async () => {
  const { chrome, sent, messageListeners } = installChrome({ pendingQuote: explainQuote });
  await boot();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  expect(chat).toBeTruthy();
  messageListeners[0]({
    type: "delta",
    requestId: chat.requestId,
    text: "比……存在得更久。例：Small tools outlive their larger competitors.",
  });
  messageListeners[0]({ type: "finish", requestId: chat.requestId });
  await flush();

  const claims = learnWordCalls(chrome);
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({
    type: "learn-word",
    surface: "outlive",
    termLang: "en",
    glossLang: "zh-CN",
    meaning: "比……存在得更久",
  });
});

it("does not claim when the user types a follow-up around a quote", async () => {
  const { chrome, sent, messageListeners } = installChrome({
    pendingQuote: { ...explainQuote, mode: "follow-up" },
  });
  await boot();
  await flush();

  // The quote chip carries a quotable, claimable term, but this is a typed
  // follow-up, not the explain auto-send path.
  expect((document.querySelector(".quote-chip") as HTMLElement).hidden).toBe(false);
  (document.querySelector("textarea") as HTMLTextAreaElement).value = "在这个句子里怎么用？";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();
  await flush();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  expect(chat).toBeTruthy();
  messageListeners[0]({
    type: "delta",
    requestId: chat.requestId,
    text: "比……存在得更久。例：Small tools outlive their larger competitors.",
  });
  messageListeners[0]({ type: "finish", requestId: chat.requestId });
  await flush();

  expect(learnWordCalls(chrome)).toHaveLength(0);
});

it("claims again when an explain request is retried", async () => {
  const { chrome, sent, messageListeners } = installChrome({ pendingQuote: explainQuote });
  await boot();
  await flush();

  const first = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({
    type: "error",
    requestId: first.requestId,
    code: "network",
    message: "Network down",
    retryable: true,
  });
  await flush();
  expect(learnWordCalls(chrome)).toHaveLength(0);

  (document.querySelector(".error-block button") as HTMLButtonElement).click();
  await flush();

  const chats = sent.filter((m) => (m as { type?: string }).type === "chat") as Array<{
    requestId: string;
  }>;
  expect(chats).toHaveLength(2);
  const retried = chats[1];
  messageListeners[0]({
    type: "delta",
    requestId: retried.requestId,
    text: "比……存在得更久。例：Small tools outlive their larger competitors.",
  });
  messageListeners[0]({ type: "finish", requestId: retried.requestId });
  await flush();

  const claims = learnWordCalls(chrome);
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({ type: "learn-word", surface: "outlive", meaning: "比……存在得更久" });
});
