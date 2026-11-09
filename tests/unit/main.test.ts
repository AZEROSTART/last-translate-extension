import { it, expect, vi, beforeEach, afterEach } from "vitest";

const originalOnMessageAddListener = (globalThis as any).chrome.runtime.onMessage.addListener;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
});

afterEach(() => {
  const main = (globalThis as any).__ilmtMain;
  if (main && typeof main.restore === "function") main.restore();
  delete (globalThis as any).__ilmtTestPort;
  delete (globalThis as any).__ilmtMain;
  // Undo chrome-surface stubs so they cannot leak into the next test.
  (globalThis as any).chrome.runtime.onMessage.addListener = originalOnMessageAddListener;
  (globalThis as any).chrome.runtime.connect = undefined;
});

/** Independent djb2 reference so the hash test asserts a real algorithm, not a mirror. */
function djb2Hex(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A port stub that records outbound messages and lets the test drive inbound ones. */
function captureConnectPort() {
  const sent: any[] = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const disconnect = vi.fn();
  const connect = vi.fn(() => ({
    postMessage: (m: unknown) => sent.push(m),
    onMessage: { addListener: (cb: (message: unknown) => void) => messageListeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => disconnectListeners.push(cb) },
    disconnect,
  }));
  return { sent, messageListeners, disconnectListeners, disconnect, connect };
}

it("translates only paragraphs near the viewport on first trigger", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p><p>Second paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();
  expect(sent.some((m) => m.type === "translate")).toBe(true);
});

it("does not send a second translate request when triggered twice in a row", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();
  await (globalThis as any).__ilmtMain.translatePage();
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);
});

it("restores the page and aborts in-flight work when toggled off", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  (globalThis as any).__ilmtTestPort = { send: vi.fn() };
  await (globalThis as any).__ilmtMain.translatePage();
  (globalThis as any).__ilmtMain.restore();
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  expect(document.querySelectorAll("[data-ilmt-p]")).toHaveLength(0);
});

it("attaches a deterministic djb2 hash to every translate item", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((m) => m.type === "translate");
  expect(translate.items).toHaveLength(1);
  expect(translate.items[0].text).toBe("First paragraph here.");
  expect(translate.items[0].hash).toBe(djb2Hex("First paragraph here."));
});

it("aborts the in-flight request with its request id on restore", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((m) => m.type === "translate");
  (globalThis as any).__ilmtMain.restore();
  expect(sent.some((m) => m.type === "abort" && m.requestId === translate.requestId)).toBe(true);
});

it("renders deltas and results and continues with the next batch on finish", async () => {
  document.body.innerHTML = Array.from({ length: 21 }, (_, i) => `<p>Paragraph number ${i} here.</p>`).join("");
  const { runContentMain } = await import("../../src/content/main");
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();

  const first = sent.find((m) => m.type === "translate");
  expect(first).toBeTruthy();
  expect(first.items).toHaveLength(20);

  const firstId = first.items[0].id;
  messageListeners[0]({ type: "delta", requestId: first.requestId, id: firstId, text: "你好" });
  expect(document.querySelector(`[data-ilmt-for="${firstId}"]`)?.textContent).toBe("你好");

  messageListeners[0]({
    type: "result",
    requestId: first.requestId,
    items: first.items.map((it: any) => ({ id: it.id, text: "译" })),
  });
  expect(document.querySelector(`[data-ilmt-for="${firstId}"]`)?.textContent).toBe("译");

  messageListeners[0]({ type: "finish", requestId: first.requestId });

  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items).toHaveLength(1);
});

it("translates newly added paragraphs after the observer debounce", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();
  const first = sent.find((m) => m.type === "translate");
  expect(first).toBeTruthy();

  // Still in flight: the new paragraph is queued, not a second request.
  document.body.insertAdjacentHTML("beforeend", `<p>New paragraph here.</p>`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);

  messageListeners[0]({ type: "finish", requestId: first.requestId });
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(2);
});

it("pings the port when the document becomes visible while active", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();

  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));

  expect(sent.some((m) => m.type === "ping")).toBe(true);
});

it("rescans and picks up new paragraphs on page-navigated", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");

  const messageListeners: Array<(message: unknown, sender: { id?: string }) => void> = [];
  (globalThis as any).chrome.runtime.onMessage.addListener = (cb: any) => messageListeners.push(cb);
  const { sent, messageListeners: portListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();
  const first = sent.find((m) => m.type === "translate");
  expect(first).toBeTruthy();
  portListeners[0]({ type: "finish", requestId: first.requestId });

  document.body.insertAdjacentHTML("beforeend", `<p>Newly added paragraph here.</p>`);
  messageListeners[0]({ type: "page-navigated" }, { id: (globalThis as any).chrome.runtime.id });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items).toHaveLength(2);
});

it("caps the page at 2000 paragraphs and warns", async () => {
  document.body.innerHTML = Array.from({ length: 2001 }, (_, i) => `<p>Text number ${i} here.</p>`).join("");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();

  expect(document.querySelectorAll("[data-ilmt-p]")).toHaveLength(2000);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

/** Give one element a synthetic viewport position for ordering assertions. */
function stubRect(el: Element, top: number, bottom: number): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

it("sends the paragraph nearest the viewport first, then the 300px band", async () => {
  document.body.innerHTML = [
    `<p id="far">Far away paragraph here.</p>`,
    `<p id="near">Nearest paragraph here.</p>`,
    `<p id="below">Just below paragraph here.</p>`,
  ].join("");
  stubRect(document.getElementById("far")!, 5000, 5050);
  stubRect(document.getElementById("near")!, 100, 150);
  stubRect(document.getElementById("below")!, 900, 950); // 132px below a 768px viewport

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (m: any) => sent.push(m) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((m) => m.type === "translate");
  expect(translate.items.map((item: any) => item.text)).toEqual([
    "Nearest paragraph here.",
    "Just below paragraph here.",
    "Far away paragraph here.",
  ]);
});

it("pumps queued paragraphs on scroll when no request is in flight", async () => {
  document.body.innerHTML = Array.from(
    { length: 21 },
    (_, i) => `<p>Paragraph number ${i} here.</p>`,
  ).join("");
  const { runContentMain } = await import("../../src/content/main");
  const { sent, disconnectListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);

  // Still in flight: a scroll must not start a second request.
  window.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 320));
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(1);

  // Server-side disconnect requeues inflight work and resumes it immediately
  // through the port client's reconnect queue.
  disconnectListeners[0]();
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(2);

  // The requeued batch is now in flight; a scroll must not preempt it.
  window.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 320));
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(2);
});

it("removes old translations before an SPA rescan so sources stay clean", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");

  const navListeners: Array<(message: unknown, sender: { id?: string }) => void> = [];
  (globalThis as any).chrome.runtime.onMessage.addListener = (cb: any) => navListeners.push(cb);
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();

  const first = sent.find((m) => m.type === "translate");
  messageListeners[0]({
    type: "result",
    requestId: first.requestId,
    items: [{ id: first.items[0].id, text: "译文" }],
  });
  const paragraph = document.querySelector("p")!;
  expect(paragraph.querySelectorAll(".ilmt-tr")).toHaveLength(1);
  expect(paragraph.textContent).toBe("First paragraph here.译文");

  navListeners[0]({ type: "page-navigated" }, { id: (globalThis as any).chrome.runtime.id });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The old translation is removed before the re-scan; the re-queued piece
  // now shows a loading skeleton while its next request is in flight.
  const loading = paragraph.querySelectorAll(".ilmt-tr");
  expect(loading).toHaveLength(1);
  expect(loading[0].getAttribute("data-loading")).toBe("1");
  expect(loading[0].textContent).toBe("");
  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items).toHaveLength(1);
  expect(translates[1].items[0].text).toBe("First paragraph here.");
});

it("defers closing the port until after the abort message is posted", async () => {
  document.body.innerHTML = `<p>First paragraph here.</p>`;
  const { runContentMain } = await import("../../src/content/main");
  const { sent, disconnect, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();
  (globalThis as any).__ilmtMain.restore();

  const abort = sent.find((m) => m.type === "abort");
  expect(abort).toBeTruthy();
  expect(disconnect).not.toHaveBeenCalled();

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(disconnect).toHaveBeenCalledTimes(1);
});
