/**
 * Runtime-message handling in the content main bundle: ask-selection opens the
 * side panel with the current selection, activate starts a translation, and
 * both keep the trusted-sender check.
 */

import { it, expect, vi, beforeEach, afterEach } from "vitest";

type MessageListener = (
  message: unknown,
  sender: { id?: string },
  sendResponse?: (response: unknown) => void,
) => void;

let listeners: MessageListener[] = [];

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  listeners = [];
  (globalThis as any).chrome.runtime.onMessage = {
    addListener: (cb: MessageListener) => listeners.push(cb),
  };
  (globalThis as any).chrome.runtime.sendMessage = vi.fn(async () => ({}));
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  const main = (globalThis as any).__ilmtMain;
  if (main && typeof main.restore === "function") main.restore();
  delete (globalThis as any).__ilmtTestPort;
  delete (globalThis as any).__ilmtMain;
  (globalThis as any).chrome.runtime.connect = undefined;
});

async function startMain(): Promise<MessageListener> {
  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const listener = listeners.at(-1);
  if (!listener) throw new Error("content main did not register a message listener");
  return listener;
}

function selectText(text: string): void {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  document.body.append(paragraph);

  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

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

/** Poll on real timers; jsdom has no layout so fixed sleeps are flaky. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("scans a body that appears after a pre-body page-navigated rescan", async () => {
  const body = document.body;
  body.innerHTML = `<p>Delayed body paragraph.</p>`;
  document.documentElement.removeChild(body);
  expect(document.body).toBeNull();

  const listener = await startMain();
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  // Activation and a rescan both arrive before the parser has a <body>.
  listener({ type: "activate" }, { id: "test-extension-id" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  listener({ type: "page-navigated" }, { id: "test-extension-id" });

  document.documentElement.appendChild(body);

  await waitFor(() => sent.some((message) => message.type === "translate"));
  const first = sent.find((message) => message.type === "translate");
  expect(first.items.map((item: any) => item.text)).toEqual(["Delayed body paragraph."]);

  // The observer must be installed too; a later paragraph needs a second scan.
  body.insertAdjacentHTML("beforeend", `<p>Later body paragraph.</p>`);
  messageListeners[0]({ type: "finish", requestId: first.requestId });
  await waitFor(
    () => sent.filter((message) => message.type === "translate").length === 2,
  );
  expect(
    sent
      .filter((message) => message.type === "translate")[1]
      .items.map((item: any) => item.text),
  ).toEqual(["Later body paragraph."]);
});

it("asks the background to explain the current selection", async () => {
  const listener = await startMain();
  selectText("  Hello world  ");

  listener({ type: "ask-selection" }, { id: "test-extension-id" });

  expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith({
    type: "open-chat",
    text: "Hello world",
    mode: "explain",
    context: {
      paragraph: "Hello world",
      preceding: [],
    },
  });
});

it("ignores an ask-selection request with a one-character selection", async () => {
  const listener = await startMain();
  selectText(" a ");

  listener({ type: "ask-selection" }, { id: "test-extension-id" });

  expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("exposes askSelection for the guard's post-load dispatch", async () => {
  await startMain();
  selectText("  Hello world  ");

  (globalThis as any).__ilmtMain.askSelection();

  expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith({
    type: "open-chat",
    text: "Hello world",
    mode: "explain",
    context: {
      paragraph: "Hello world",
      preceding: [],
    },
  });
});

it("ignores ask-selection from another extension", async () => {
  const listener = await startMain();
  selectText("Hello world");

  listener({ type: "ask-selection" }, { id: "someone-else" });

  expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("starts translation on a trusted activate message", async () => {
  const listener = await startMain();
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };

  listener({ type: "activate" }, { id: "test-extension-id" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(sent.some((message) => message.type === "translate")).toBe(true);
});

it("toggles restore when activate arrives while translation is active", async () => {
  const listener = await startMain();
  document.body.innerHTML = `<p>Hello world from the page.</p>`;
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  listener({ type: "activate" }, { id: "test-extension-id" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const request = sent.find((message) => message.type === "translate");
  expect(request).toBeTruthy();
  expect(document.querySelectorAll(".ilmt-active-banner")).toHaveLength(1);

  messageListeners[0]({
    type: "result",
    requestId: request.requestId,
    items: [{ id: request.items[0].id, text: "译文" }],
  });
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  listener({ type: "activate" }, { id: "test-extension-id" });

  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  expect(document.querySelectorAll("[data-ilmt-p]")).toHaveLength(0);
  expect(document.querySelectorAll(".ilmt-active-banner")).toHaveLength(0);
});

it("answers get-recent-translations with the last five finished paragraphs", async () => {
  const listener = await startMain();
  document.body.innerHTML = Array.from(
    { length: 6 },
    (_, i) => `<p>Paragraph number ${i} here.</p>`,
  ).join("");
  const { sent, messageListeners, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;

  listener({ type: "activate" }, { id: "test-extension-id" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const request = sent.find((message) => message.type === "translate");
  expect(request.items).toHaveLength(6);
  messageListeners[0]({
    type: "result",
    requestId: request.requestId,
    items: request.items.map((item: any, index: number) => ({
      id: item.id,
      text: `译文 ${index}`,
    })),
  });

  const sendResponse = vi.fn();
  listener({ type: "get-recent-translations" }, { id: "test-extension-id" }, sendResponse);

  expect(sendResponse).toHaveBeenCalledTimes(1);
  const response = sendResponse.mock.calls[0][0];
  expect(response.paragraphs).toHaveLength(5);
  expect(response.paragraphs.map((item: any) => item.source)).toEqual([
    "Paragraph number 1 here.",
    "Paragraph number 2 here.",
    "Paragraph number 3 here.",
    "Paragraph number 4 here.",
    "Paragraph number 5 here.",
  ]);
  expect(response.paragraphs.at(-1).translation).toBe("译文 5");
});

it("does not answer get-recent-translations from another extension", async () => {
  const listener = await startMain();
  const sendResponse = vi.fn();

  listener({ type: "get-recent-translations" }, { id: "someone-else" }, sendResponse);

  expect(sendResponse).not.toHaveBeenCalled();
});
