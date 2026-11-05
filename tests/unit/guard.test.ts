import { describe, it, expect, vi, beforeEach } from "vitest";

const runContentMain = vi.fn();
const loadMain = vi.fn(async (_url: string) => ({ runContentMain }));

type Listener = (message: unknown, sender: unknown, sendResponse: () => void) => void;

function lastListener(): Listener {
  const listener = (chrome.runtime.onMessage.addListener as any).mock.calls.at(-1)?.[0] as
    | Listener
    | undefined;
  expect(listener, "guard must register an onMessage listener").toBeTypeOf("function");
  return listener!;
}

/** Let the fire-and-forget dynamic import settle before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete (globalThis as { __ilmtGuard?: unknown }).__ilmtGuard;
  delete (globalThis as { __ilmtPendingAskSelection?: unknown }).__ilmtPendingAskSelection;
  delete (globalThis as { __ilmtMain?: unknown }).__ilmtMain;
  (globalThis as { __ilmtImport?: unknown }).__ilmtImport = loadMain;
});

describe("content script guard", () => {
  it("registers an onMessage listener when the script loads", async () => {
    await import("../../src/content/guard");
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  it("initializes the main bundle only once even if activated twice", async () => {
    await import("../../src/content/guard");
    const listener = lastListener();

    listener({ type: "activate" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
    await settle();
    listener({ type: "activate" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
    await settle();

    expect(runContentMain).toHaveBeenCalledTimes(1);
    expect(loadMain).toHaveBeenCalledTimes(1);
    expect(loadMain).toHaveBeenCalledWith(chrome.runtime.getURL("content_main.js"));
  });

  it("ignores messages from another extension", async () => {
    await import("../../src/content/guard");
    const listener = lastListener();

    listener({ type: "activate" }, { id: "other" }, () => {});
    await settle();

    expect(runContentMain).not.toHaveBeenCalled();
    expect(loadMain).not.toHaveBeenCalled();
  });

  it("loads the main bundle and dispatches ask-selection before any activate", async () => {
    const askSelection = vi.fn();
    loadMain.mockImplementationOnce(async () => {
      (globalThis as { __ilmtMain?: unknown }).__ilmtMain = { askSelection };
      return { runContentMain };
    });

    await import("../../src/content/guard");
    const listener = lastListener();

    listener({ type: "ask-selection" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
    await settle();

    expect(loadMain).toHaveBeenCalledTimes(1);
    expect(runContentMain).toHaveBeenCalledTimes(1);
    expect(askSelection).toHaveBeenCalledTimes(1);
  });

  it("does not re-import when ask-selection arrives after the main bundle loaded", async () => {
    const askSelection = vi.fn();
    loadMain.mockImplementationOnce(async () => {
      (globalThis as { __ilmtMain?: unknown }).__ilmtMain = { askSelection };
      return { runContentMain };
    });

    await import("../../src/content/guard");
    const listener = lastListener();

    listener({ type: "ask-selection" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
    await settle();
    listener({ type: "ask-selection" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
    await settle();

    expect(loadMain).toHaveBeenCalledTimes(1);
    expect(askSelection).toHaveBeenCalledTimes(1);
  });

  it("ignores ask-selection from another extension", async () => {
    await import("../../src/content/guard");
    const listener = lastListener();

    listener({ type: "ask-selection" }, { id: "other" }, () => {});
    await settle();

    expect(loadMain).not.toHaveBeenCalled();
  });
});
