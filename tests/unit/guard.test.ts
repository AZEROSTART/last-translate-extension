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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  loadMain.mockImplementation(async () => ({ runContentMain }));
  await chrome.storage.local.clear();
  delete (globalThis as { __ilmtGuard?: unknown }).__ilmtGuard;
  delete (globalThis as { __ilmtPendingAskSelection?: unknown }).__ilmtPendingAskSelection;
  delete (globalThis as { __ilmtPendingActivate?: unknown }).__ilmtPendingActivate;
  delete (globalThis as { __ilmtPendingBubble?: unknown }).__ilmtPendingBubble;
  delete (globalThis as { __ilmtMain?: unknown }).__ilmtMain;
  const previous = (globalThis as { __ilmtMouseupHandler?: (event: MouseEvent) => void })
    .__ilmtMouseupHandler;
  if (previous) document.removeEventListener("mouseup", previous);
  delete (globalThis as { __ilmtMouseupHandler?: unknown }).__ilmtMouseupHandler;
  (globalThis as { __ilmtImport?: unknown }).__ilmtImport = loadMain;
  (chrome.runtime as { id?: string }).id = "test-extension-id";
  (chrome.runtime.getURL as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (path: string) => `chrome-extension://test-extension-id/${path}`,
  );
  window.getSelection()?.removeAllRanges();
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

  it("translates on the first trusted activate that triggers the load", async () => {
    const translatePage = vi.fn(async () => {});
    loadMain.mockImplementationOnce(async () => {
      (globalThis as { __ilmtMain?: unknown }).__ilmtMain = { translatePage };
      return { runContentMain };
    });

    await import("../../src/content/guard");
    const listener = lastListener();
    listener({ type: "activate" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
    await settle();

    expect(loadMain).toHaveBeenCalledTimes(1);
    expect(runContentMain).toHaveBeenCalledTimes(1);
    expect(translatePage).toHaveBeenCalledTimes(1);
  });

  describe("first-selection bubble", () => {
    function selectParagraph(text: string): void {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      document.body.append(paragraph);
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }

    it("loads the main bundle once and shows the bubble on a qualifying mouseup", async () => {
      const showSelectionBubble = vi.fn();
      loadMain.mockImplementationOnce(async () => {
        (globalThis as { __ilmtMain?: unknown }).__ilmtMain = { showSelectionBubble };
        return { runContentMain };
      });

      await import("../../src/content/guard");
      selectParagraph("Hello world");
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await settle();

      expect(loadMain).toHaveBeenCalledTimes(1);
      expect(runContentMain).toHaveBeenCalledTimes(1);
      expect(showSelectionBubble).toHaveBeenCalledTimes(1);
    });

    it("does not load the bundle for a one-character selection", async () => {
      await import("../../src/content/guard");
      selectParagraph("a");
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await settle();

      expect(loadMain).not.toHaveBeenCalled();
    });

    it("does not load the bundle for a selection inside an editable control", async () => {
      await import("../../src/content/guard");
      document.body.innerHTML = `<div contenteditable="true">Hello world</div>`;
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("div")!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await settle();

      expect(loadMain).not.toHaveBeenCalled();
    });

    it("does not throw when the extension context was invalidated", async () => {
      await import("../../src/content/guard");
      const handler = (globalThis as { __ilmtMouseupHandler?: () => void }).__ilmtMouseupHandler;
      expect(handler, "the guard must bind its own mouseup handler").toBeTypeOf("function");

      // What a reloaded/removed extension leaves behind: `getURL` throws
      // synchronously and `runtime.id` is gone.
      (chrome.runtime as { id?: string }).id = undefined;
      (chrome.runtime.getURL as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("Extension context invalidated.");
      });

      selectParagraph("Hello world");
      expect(() => handler!()).not.toThrow();
      await settle();

      expect(loadMain).not.toHaveBeenCalled();
      // One failed attempt, then the dead listener is dropped instead of
      // repeating the throw on every later mouseup.
      expect(chrome.runtime.getURL).toHaveBeenCalledTimes(1);
      expect(
        (globalThis as { __ilmtMouseupHandler?: unknown }).__ilmtMouseupHandler,
      ).toBeUndefined();
    });

    it("retries the load after a transient failure", async () => {
      loadMain.mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"));

      await import("../../src/content/guard");
      const listener = lastListener();
      listener({ type: "activate" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
      await settle();
      expect(runContentMain).not.toHaveBeenCalled();

      listener({ type: "activate" }, { id: chrome.runtime.id, tab: { id: 1 } }, () => {});
      await settle();

      expect(loadMain).toHaveBeenCalledTimes(2);
      expect(runContentMain).toHaveBeenCalledTimes(1);
    });
  });

  describe("triggerMode: auto-current-site", () => {
    async function importWith(settings: unknown): Promise<void> {
      await chrome.storage.local.set({ settings });
      await import("../../src/content/guard");
      // Covers both the settled-document and DOMContentLoaded branches.
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await settle();
      await settle();
    }

    it("loads the main bundle and translates once", async () => {
      const translatePage = vi.fn(async () => {});
      loadMain.mockImplementationOnce(async () => {
        (globalThis as { __ilmtMain?: unknown }).__ilmtMain = { translatePage };
        return { runContentMain };
      });

      await importWith({ triggerMode: "auto-current-site", siteRules: {} });

      expect(loadMain).toHaveBeenCalledTimes(1);
      expect(translatePage).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the host is marked never", async () => {
      await importWith({
        triggerMode: "auto-current-site",
        siteRules: { [location.hostname]: "never" },
      });

      expect(loadMain).not.toHaveBeenCalled();
    });

    it("stays shortcut-only for triggerMode shortcut", async () => {
      await importWith({ triggerMode: "shortcut", siteRules: {} });

      expect(loadMain).not.toHaveBeenCalled();
    });
  });
});
