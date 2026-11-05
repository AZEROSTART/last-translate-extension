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
    for (const [k, v] of Object.entries(items)) store.set(k, clone(v));
    return Promise.resolve();
  };

  const remove = (keys: string | string[]): Promise<void> => {
    for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    return Promise.resolve();
  };

  return { get, set, remove, _store: store };
}

interface ChromeOpts {
  pendingQuote?: unknown;
  history?: unknown;
  tab?: { id: number; url: string; title: string };
}

function installChrome(opts: ChromeOpts = {}) {
  const storage = makeStorage();
  if (opts.pendingQuote !== undefined) storage._store.set("chat.pendingQuote", opts.pendingQuote);
  if (opts.history !== undefined) storage._store.set("chat.history", opts.history);

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
    },
    storage: { local: storage },
    tabs: {
      query: vi.fn(async () => [opts.tab ?? { id: 1, url: "https://a.test/x", title: "A", windowId: 1 }]),
      onActivated: { addListener: (cb: Listener) => activatedListeners.push(cb) },
      onUpdated: { addListener: (cb: Listener) => updatedListeners.push(cb) },
    },
  };
  (globalThis as any).chrome = chrome;

  return { chrome, storage, port, sent, messageListeners, disconnectListeners, activatedListeners, updatedListeners };
}

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
});

async function boot() {
  await import("../../src/panel/main");
  await (globalThis as any).__ilmtPanel.ready;
}

it("renders the fixed context note", async () => {
  installChrome();
  await boot();
  expect(document.querySelector(".context-note")?.textContent).toBe("只参考已翻译的段落");
});

it("renders the pending quote chip and clears it from storage on load", async () => {
  const { storage } = installChrome({ pendingQuote: { text: "选中的文字", mode: "explain", tabId: 1, ts: 1 } });
  await boot();

  const chip = document.querySelector(".quote-chip") as HTMLElement;
  expect(chip.hidden).toBe(false);
  expect(chip.textContent).toContain("选中的文字");
  expect(storage._store.has("chat.pendingQuote")).toBe(false);
});

it("sends a chat request and appends streamed deltas to the assistant message", async () => {
  const { sent, messageListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "这是什么？";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();

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

it("aborts an in-flight request and keeps the partial answer with a resend action", async () => {
  const { sent, messageListeners } = installChrome();
  await boot();

  const input = document.querySelector("textarea") as HTMLTextAreaElement;
  input.value = "问题";
  (document.querySelector(".composer-send") as HTMLButtonElement).click();

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as { requestId: string };
  messageListeners[0]({ type: "delta", requestId: chat.requestId, text: "部分" });

  (document.querySelector(".composer-stop") as HTMLButtonElement).click();
  expect(sent.some((m) => (m as { type?: string }).type === "abort")).toBe(true);

  const assistant = document.querySelector(".msg--assistant .msg-body") as HTMLElement;
  expect(assistant.textContent).toBe("部分");
  expect(document.querySelector(".error-block")?.textContent).toContain("已中断");
  expect(document.querySelector(".error-block")?.textContent).toContain("重新发送");
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

  const chat = sent.find((m) => (m as { type?: string }).type === "chat") as {
    context: { pageUrl: string; title: string; recentParagraphs: unknown[] };
  };
  expect(chat).toBeTruthy();
  expect(chat.context.pageUrl).toBe("");
  expect(chat.context.title).toBe("");
  expect(chat.context.recentParagraphs).toEqual([]);
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
