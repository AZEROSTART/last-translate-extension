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
