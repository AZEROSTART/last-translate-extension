/**
 * Content-main user-visible behavior: streaming accumulation, the active
 * banner, error banners/retry, rate-limit requeue and paragraph invalidation.
 */

import { it, expect, vi, beforeEach, afterEach } from "vitest";

function captureConnectPort() {
  const sent: any[] = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  const connect = vi.fn(() => ({
    postMessage: (message: unknown) => sent.push(message),
    onMessage: { addListener: (cb: (message: unknown) => void) => messageListeners.push(cb) },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
  }));
  return { sent, messageListeners, connect };
}

async function startTranslating(): Promise<{
  sent: any[];
  deliver: (message: unknown) => void;
  request: any;
}> {
  const { runContentMain } = await import("../../src/content/main");
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;
  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();
  const request = sent.find((message) => message.type === "translate");
  if (!request) throw new Error("translation did not start");
  return { sent, deliver: (message) => messageListeners[0](message), request };
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  (globalThis as any).chrome.runtime.sendMessage = vi.fn(async () => ({}));
  delete (globalThis as any).__ilmtTestPort;
});

afterEach(() => {
  const main = (globalThis as any).__ilmtMain;
  if (main && typeof main.restore === "function") main.restore();
  delete (globalThis as any).__ilmtTestPort;
  delete (globalThis as any).__ilmtMain;
  (globalThis as any).chrome.runtime.connect = undefined;
  vi.useRealTimers();
});

it("appends streaming deltas instead of replacing the previous chunk", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { deliver, request } = await startTranslating();
  const id = request.items[0].id;

  deliver({ type: "delta", requestId: request.requestId, id, text: "你" });
  deliver({ type: "delta", requestId: request.requestId, id, text: "好" });

  expect(document.querySelector(`[data-ilmt-for="${id}"]`)?.textContent).toBe("你好");
});

it("shows an auth banner with a 设置 button and keeps the failure", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { sent, deliver, request } = await startTranslating();

  deliver({
    type: "error",
    requestId: request.requestId,
    code: "auth",
    message: "invalid key",
    retryable: false,
    ids: request.items.map((item: any) => item.id),
  });
  deliver({ type: "finish", requestId: request.requestId });

  const banner = document.querySelector(".ilmt-error-banner")!;
  expect(banner.textContent).toContain("API key 无效或权限不足");
  expect(banner.querySelector(".ilmt-error-options")).not.toBeNull();
  expect(banner.querySelector(".ilmt-error-retry")).toBeNull();

  banner.querySelector<HTMLButtonElement>(".ilmt-error-options")!.click();
  expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith({
    type: "open-options",
  });

  // Non-rate-limit failures are not retried automatically.
  expect(sent.filter((message) => message.type === "translate")).toHaveLength(1);
  expect(document.querySelector(".ilmt-error-banner")).not.toBeNull();
});

it("shows the no-provider banner for the background's NO_PROVIDER message", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { deliver, request } = await startTranslating();

  deliver({
    type: "error",
    requestId: request.requestId,
    code: "bad_response",
    message: "未选择模型配置",
    retryable: false,
    ids: [request.items[0].id],
  });
  deliver({ type: "finish", requestId: request.requestId });

  expect(document.querySelector(".ilmt-error-message")!.textContent).toBe("尚未配置模型");
  expect(document.querySelector(".ilmt-error-options")).not.toBeNull();
});

it("shows the format banner for a bad_response that is not no-provider", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { deliver, request } = await startTranslating();

  deliver({
    type: "error",
    requestId: request.requestId,
    code: "bad_response",
    message: "unparseable JSON",
    retryable: false,
    ids: [request.items[0].id],
  });
  deliver({ type: "finish", requestId: request.requestId });

  expect(document.querySelector(".ilmt-error-message")!.textContent).toBe("模型返回格式不符");
});

it("retries failed paragraphs from the banner via the registry source text", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { sent, deliver, request } = await startTranslating();

  deliver({
    type: "error",
    requestId: request.requestId,
    code: "timeout",
    message: "timed out",
    retryable: true,
    ids: [request.items[0].id],
  });
  deliver({ type: "finish", requestId: request.requestId });
  expect(document.querySelector(".ilmt-error-message")!.textContent).toBe("翻译失败，可重试");

  document.querySelector<HTMLButtonElement>(".ilmt-error-retry")!.click();

  const translates = sent.filter((message) => message.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items[0].text).toBe("Hello world from the page.");
  expect(document.querySelector(".ilmt-error-banner")).toBeNull();
});

it("requeues a rate-limited batch and retries it once after the delay", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { sent, deliver, request } = await startTranslating();

  vi.useFakeTimers();
  deliver({
    type: "error",
    requestId: request.requestId,
    code: "rate_limit",
    message: "429",
    retryable: true,
    ids: [request.items[0].id],
  });
  deliver({ type: "finish", requestId: request.requestId });

  expect(document.querySelector(".ilmt-error-message")!.textContent).toBe(
    "请求过于频繁，稍后自动重试",
  );
  expect(sent.filter((message) => message.type === "translate")).toHaveLength(1);

  vi.advanceTimersByTime(3000);
  expect(sent.filter((message) => message.type === "translate")).toHaveLength(2);
});

it("keeps one banner instance and lets the user dismiss it", async () => {
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { deliver, request } = await startTranslating();

  for (const message of ["first failure", "second failure"]) {
    deliver({
      type: "error",
      requestId: request.requestId,
      code: "network",
      message,
      retryable: true,
      ids: [request.items[0].id],
    });
  }
  expect(document.querySelectorAll(".ilmt-error-banner")).toHaveLength(1);

  document.querySelector<HTMLButtonElement>(".ilmt-error-close")!.click();
  expect(document.querySelector(".ilmt-error-banner")).toBeNull();
});

it("drops a stale translation and re-queues a paragraph edited via characterData", async () => {
  document.body.innerHTML = `<p>Original paragraph text.</p>`;
  const { deliver, request } = await startTranslating();
  const id = request.items[0].id;

  deliver({
    type: "result",
    requestId: request.requestId,
    items: [{ id, text: "译文" }],
  });
  const paragraph = document.querySelector("p")!;
  expect(paragraph.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  paragraph.firstChild!.textContent = "Edited paragraph text.";
  await new Promise((resolve) => setTimeout(resolve, 350));

  expect(paragraph.querySelectorAll(".ilmt-tr")).toHaveLength(0);
});
