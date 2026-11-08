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
  delete (globalThis as any).chrome.i18n;
  (globalThis as any).chrome.runtime.connect = undefined;
  vi.useRealTimers();
});

/** Poll until `condition` holds so async scans can be driven without fixed sleeps. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

it("requeues every failed group when one request reports several errors", async () => {
  document.body.innerHTML = `<p>First failed group paragraph.</p><p>Second failed group paragraph.</p>`;
  const { sent, deliver, request } = await startTranslating();
  expect(request.items).toHaveLength(2);
  const [first, second] = request.items;

  // Both errors belong to the SAME request. The first one must not clear the
  // request id and strand the second group inflight.
  deliver({
    type: "error",
    requestId: request.requestId,
    code: "timeout",
    message: "first group failed",
    retryable: true,
    ids: [first.id],
  });
  deliver({
    type: "error",
    requestId: request.requestId,
    code: "timeout",
    message: "second group failed",
    retryable: true,
    ids: [second.id],
  });
  deliver({ type: "finish", requestId: request.requestId });

  document.querySelector<HTMLButtonElement>(".ilmt-error-retry")!.click();

  const translates = sent.filter((message) => message.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items.map((item: any) => item.id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
});

it("stops auto-retrying rate limits at the cap and offers a manual retry", async () => {
  document.body.innerHTML = `<p>First rate limited paragraph.</p><p>Second rate limited paragraph.</p>`;
  const { sent, deliver } = await startTranslating();
  vi.useFakeTimers();

  let request = sent.find((message) => message.type === "translate");
  expect(request.items).toHaveLength(2);

  const delays = [3000, 6000, 12000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    // Two 429 groups for the same request must still count as one attempt.
    deliver({
      type: "error",
      requestId: request.requestId,
      code: "rate_limit",
      message: "429",
      retryable: true,
      ids: [request.items[0].id],
    });
    deliver({
      type: "error",
      requestId: request.requestId,
      code: "rate_limit",
      message: "429",
      retryable: true,
      ids: [request.items[1].id],
    });
    deliver({ type: "finish", requestId: request.requestId });

    expect(document.querySelector(".ilmt-error-message")!.textContent).toBe(
      "请求过于频繁，稍后自动重试",
    );

    // The backoff grows: no retry one millisecond before this attempt's delay.
    vi.advanceTimersByTime(delays[attempt] - 1);
    expect(sent.filter((message) => message.type === "translate")).toHaveLength(attempt + 1);
    vi.advanceTimersByTime(1);
    request = sent.filter((message) => message.type === "translate").at(-1);
  }

  // Initial request plus exactly three automatic retries.
  expect(sent.filter((message) => message.type === "translate")).toHaveLength(4);

  // The fourth 429 exhausts the budget: no more timer, manual retry only.
  deliver({
    type: "error",
    requestId: request.requestId,
    code: "rate_limit",
    message: "429",
    retryable: true,
    ids: [request.items[0].id],
  });
  deliver({
    type: "error",
    requestId: request.requestId,
    code: "rate_limit",
    message: "429",
    retryable: true,
    ids: [request.items[1].id],
  });
  deliver({ type: "finish", requestId: request.requestId });

  expect(document.querySelector(".ilmt-error-message")!.textContent).toBe(
    "请求过于频繁，请稍后手动重试",
  );
  const retryButton = document.querySelector<HTMLButtonElement>(".ilmt-error-retry");
  expect(retryButton).not.toBeNull();

  vi.advanceTimersByTime(60_000);
  expect(sent.filter((message) => message.type === "translate")).toHaveLength(4);

  retryButton!.click();
  expect(sent.filter((message) => message.type === "translate")).toHaveLength(5);
});

it("cancels an in-flight scan on restore without marking or sending anything", async () => {
  document.body.innerHTML = `<p>Slow paragraph to detect.</p>`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  (chrome as any).i18n = {
    detectLanguage: vi.fn((_text: string, callback: (result: unknown) => void) => {
      calls += 1;
      void gate.then(() => callback({ languages: [{ language: "en", percentage: 100 }] }));
    }),
  };

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };

  const scanning = (globalThis as any).__ilmtMain.translatePage();
  await until(() => calls > 0);
  (globalThis as any).__ilmtMain.restore();
  release();
  await scanning;

  expect(document.querySelectorAll("[data-ilmt-p]")).toHaveLength(0);
  expect(sent.filter((message) => message.type === "translate")).toHaveLength(0);
});

it("serializes mutation scans behind a slow initial scan", async () => {
  document.body.innerHTML = `<p>Initial paragraph here.</p>`;
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  (chrome as any).i18n = {
    detectLanguage: vi.fn((_text: string, callback: (result: unknown) => void) => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const finish = () => {
        concurrent -= 1;
        callback({ languages: [{ language: "en", percentage: 100 }] });
      };
      if (calls === 1) void firstGate.then(finish);
      else finish();
    }),
  };

  const { runContentMain } = await import("../../src/content/main");
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;
  runContentMain();

  const scanning = (globalThis as any).__ilmtMain.translatePage();
  await until(() => calls > 0);

  document.body.insertAdjacentHTML("beforeend", `<p>Mutated paragraph here.</p>`);
  // Past the mutation debounce: the follow-up scan must be queued, not run
  // alongside the still-blocked initial scan.
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(maxConcurrent).toBe(1);

  releaseFirst();
  await scanning;
  expect(maxConcurrent).toBe(1);

  const first = sent.find((message) => message.type === "translate");
  expect(first.items.map((item: any) => item.text)).toEqual(["Initial paragraph here."]);

  messageListeners[0]({ type: "finish", requestId: first.requestId });
  const translates = sent.filter((message) => message.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items.map((item: any) => item.text)).toEqual([
    "Mutated paragraph here.",
  ]);
});

it("drops the old translation and re-queues an edited translated piece", async () => {
  document.body.innerHTML = `<p>Original paragraph text.</p>`;
  const { sent, deliver, request } = await startTranslating();
  const id = request.items[0].id;
  deliver({ type: "result", requestId: request.requestId, items: [{ id, text: "译文" }] });
  deliver({ type: "finish", requestId: request.requestId });
  const paragraph = document.querySelector("p")!;
  expect(paragraph.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  paragraph.firstChild!.textContent = "Edited paragraph text.";
  await new Promise((resolve) => setTimeout(resolve, 350));

  expect(paragraph.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items[0].text).toBe("Edited paragraph text.");
});

it("re-collects a skipped short piece after it grows", async () => {
  document.body.innerHTML = `<p>abc</p>`;
  const { runContentMain } = await import("../../src/content/main");
  const { sent, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;
  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(0);

  document.querySelector("p")!.firstChild!.textContent = "This text is long enough now.";
  await new Promise((resolve) => setTimeout(resolve, 350));

  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(1);
  expect(translates[0].items[0].text).toBe("This text is long enough now.");
});

it("removes an orphaned translation after its anchor is replaced", async () => {
  document.body.innerHTML = `<p>Original paragraph text.</p>`;
  const { sent, deliver, request } = await startTranslating();
  const id = request.items[0].id;
  deliver({ type: "result", requestId: request.requestId, items: [{ id, text: "译文" }] });
  deliver({ type: "finish", requestId: request.requestId });
  const p = document.querySelector("p")!;
  expect(p.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  const oldText = p.firstChild!;
  p.removeChild(oldText);
  p.insertBefore(document.createTextNode("Replacement paragraph text."), p.firstChild);
  await new Promise((resolve) => setTimeout(resolve, 350));

  expect(p.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items[0].text).toBe("Replacement paragraph text.");
});

it("preserves a nested inner piece when the outer piece is edited", async () => {
  document.body.innerHTML =
    `<div id="outer">Outer paragraph text.<div id="inner">Inner paragraph text.</div>` +
    `Outer ending text.</div>`;
  const { sent, deliver, request } = await startTranslating();
  expect(request.items).toHaveLength(3);

  deliver({
    type: "result",
    requestId: request.requestId,
    items: request.items.map((item: any) => ({ id: item.id, text: `译-${item.id}` })),
  });
  deliver({ type: "finish", requestId: request.requestId });

  const inner = document.querySelector("#inner")!;
  expect(inner.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  document.querySelector("#outer")!.firstChild!.textContent = "Edited outer paragraph text.";

  await until(() => sent.filter((m) => m.type === "translate").length === 2);

  const texts = sent.filter((m) => m.type === "translate")[1].items.map((item: any) => item.text);
  expect(texts).toContain("Edited outer paragraph text.");
  expect(texts).toContain("Outer ending text.");
  expect(texts).not.toContain("Inner paragraph text.");
  expect(inner.querySelectorAll(".ilmt-tr")).toHaveLength(1);
});

it("preserves a marked sibling piece when a skipped sibling grows", async () => {
  document.body.innerHTML = `<div id="outer"><p>Marked paragraph text.</p><span>ab</span></div>`;
  const { sent, deliver, request } = await startTranslating();
  expect(request.items).toHaveLength(1);

  deliver({
    type: "result",
    requestId: request.requestId,
    items: [{ id: request.items[0].id, text: "译文" }],
  });
  deliver({ type: "finish", requestId: request.requestId });

  const p = document.querySelector("p")!;
  expect(p.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  // The `ab` span is a direct child of `#outer`, distinct from the `.ilmt-tr`
  // span rendered inside the marked `<p>`.
  document.querySelector("#outer > span")!.firstChild!.textContent =
    "This is now a long enough sentence to translate.";

  await until(() => sent.filter((m) => m.type === "translate").length === 2);

  const texts = sent.filter((m) => m.type === "translate")[1].items.map((item: any) => item.text);
  expect(texts).toEqual(["This is now a long enough sentence to translate."]);
  expect(texts).not.toContain("Marked paragraph text.");
  expect(p.querySelectorAll(".ilmt-tr")).toHaveLength(1);
});
