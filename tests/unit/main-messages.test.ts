/**
 * Runtime-message handling in the content main bundle: ask-selection opens the
 * side panel with the current selection, activate starts a translation, and
 * both keep the trusted-sender check.
 */

import { it, expect, vi, beforeEach, afterEach } from "vitest";

type MessageListener = (message: unknown, sender: { id?: string }) => void;

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

it("asks the background to explain the current selection", async () => {
  const listener = await startMain();
  selectText("  Hello world  ");

  listener({ type: "ask-selection" }, { id: "test-extension-id" });

  expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith({
    type: "open-chat",
    text: "Hello world",
    mode: "explain",
  });
});

it("ignores an ask-selection request with a one-character selection", async () => {
  const listener = await startMain();
  selectText(" a ");

  listener({ type: "ask-selection" }, { id: "test-extension-id" });

  expect((globalThis as any).chrome.runtime.sendMessage).not.toHaveBeenCalled();
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
