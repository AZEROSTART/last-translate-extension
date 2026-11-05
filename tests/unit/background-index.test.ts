/**
 * Wiring tests for `src/background/index.ts`: the port-disconnect path must
 * cancel the tab's queued/inflight work even when the content script's `abort`
 * never arrives. `index.ts` is side-effectful, so each test installs a fresh
 * `chrome` surface, re-imports the module and spies on the queue prototype.
 */

import { it, expect, vi, beforeEach, afterEach } from "vitest";

type Listener = (...args: any[]) => void;

function installChrome() {
  const onConnect: Listener[] = [];
  const onMessage: Listener[] = [];
  const onCommand: Listener[] = [];
  const sidePanelOpen = vi.fn(async () => {});
  const setPanelBehavior = vi.fn(async () => {});
  const storageSet = vi.fn(async () => {});
  const tabsQuery = vi.fn(async () => [{ id: 42 }]);
  const tabsSendMessage = vi.fn(async () => undefined);
  const openOptionsPage = vi.fn(async () => {});
  const tabsCreate = vi.fn(async () => ({}));
  (globalThis as any).chrome = {
    runtime: {
      id: "test-extension-id",
      onConnect: { addListener: (cb: Listener) => onConnect.push(cb) },
      onMessage: { addListener: (cb: Listener) => onMessage.push(cb) },
      openOptionsPage,
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
    commands: { onCommand: { addListener: (cb: Listener) => onCommand.push(cb) } },
    webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      query: tabsQuery,
      sendMessage: tabsSendMessage,
      create: tabsCreate,
    },
    sidePanel: { open: sidePanelOpen, setPanelBehavior },
    storage: { local: { set: storageSet, get: vi.fn(async () => ({})), remove: vi.fn(async () => {}) } },
  };
  return {
    onConnect,
    onMessage,
    onCommand,
    sidePanelOpen,
    setPanelBehavior,
    storageSet,
    tabsQuery,
    tabsSendMessage,
    openOptionsPage,
    tabsCreate,
  };
}

function fakePort(name: string, tabId: number | undefined, frameId?: number) {
  const disconnectListeners: Listener[] = [];
  return {
    name,
    sender:
      tabId === undefined
        ? { id: "test-extension-id" }
        : { id: "test-extension-id", tab: { id: tabId }, ...(frameId === undefined ? {} : { frameId }) },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: (cb: Listener) => disconnectListeners.push(cb) },
    disconnectListeners,
  };
}

const originalChrome = (globalThis as any).chrome;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).chrome = originalChrome;
});

async function importIndexAndSpyOnQueue() {
  await import("../../src/background/index");
  const { RequestQueue } = await import("../../src/background/queue");
  return vi.spyOn(RequestQueue.prototype, "cancelTab").mockImplementation(() => {});
}

it("cancels the tab's work when the translate port disconnects", async () => {
  const { onConnect } = installChrome();
  const cancelTab = await importIndexAndSpyOnQueue();

  const port = fakePort("ilmt-translate", 42);
  onConnect[0](port);
  expect(port.disconnectListeners).toHaveLength(1);

  port.disconnectListeners[0]();
  expect(cancelTab).toHaveBeenCalledWith(42);
});

it("cancels the tab's work when the chat port disconnects", async () => {
  const { onConnect } = installChrome();
  const cancelTab = await importIndexAndSpyOnQueue();

  const port = fakePort("ilmt-chat", 7);
  onConnect[0](port);
  expect(port.disconnectListeners).toHaveLength(1);

  port.disconnectListeners[0]();
  expect(cancelTab).toHaveBeenCalledWith(7);
});

it("does not cancel when the sender has no tab id", async () => {
  const { onConnect } = installChrome();
  const cancelTab = await importIndexAndSpyOnQueue();

  const port = fakePort("ilmt-translate", undefined);
  onConnect[0](port);

  port.disconnectListeners[0]();
  expect(cancelTab).not.toHaveBeenCalled();
});

it("stashes the quote and opens the side panel on open-chat from this extension", async () => {
  const { onMessage, sidePanelOpen, storageSet } = installChrome();
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-chat", text: "选中文字", mode: "explain" }, {
    id: "test-extension-id",
    tab: { id: 9 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(storageSet).toHaveBeenCalledWith({
    "chat.pendingQuote": expect.objectContaining({ text: "选中文字", mode: "explain", tabId: 9 }),
  });
  expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 9 });
});

it("ignores open-chat from another extension", async () => {
  const { onMessage, sidePanelOpen, storageSet } = installChrome();
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-chat", text: "x", mode: "explain" }, {
    id: "someone-else",
    tab: { id: 9 },
  });

  expect(storageSet).not.toHaveBeenCalled();
  expect(sidePanelOpen).not.toHaveBeenCalled();
});

it("opens the side panel on toolbar action click at startup", async () => {
  const { setPanelBehavior } = installChrome();
  await importIndexAndSpyOnQueue();

  expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
});

it("sends activate to the command's tab without an async active-tab lookup", async () => {
  const { onCommand, tabsQuery, tabsSendMessage } = installChrome();
  await importIndexAndSpyOnQueue();

  onCommand[0]("translate-page", { id: 7, tab: { id: 7 } });

  // The command event supplies the tab; no promise may precede sendMessage.
  expect(tabsQuery).not.toHaveBeenCalled();
  expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: "activate" });
});

it("sends ask-selection to the command's tab", async () => {
  const { onCommand, tabsQuery, tabsSendMessage } = installChrome();
  await importIndexAndSpyOnQueue();

  onCommand[0]("ask-selection", { id: 7, tab: { id: 7 } });

  expect(tabsQuery).not.toHaveBeenCalled();
  expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: "ask-selection" });
});

it("opens the side panel synchronously from the command's tab (gesture preserved)", async () => {
  const { onCommand, tabsQuery, sidePanelOpen } = installChrome();
  await importIndexAndSpyOnQueue();

  onCommand[0]("toggle-side-panel", { id: 7, tab: { id: 7 } });

  // Assert before any timer tick: an await before open() would lose the gesture.
  expect(tabsQuery).not.toHaveBeenCalled();
  expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 7 });
});

it("falls back to tabs.query when the command event has no tab", async () => {
  const { onCommand, tabsQuery, tabsSendMessage } = installChrome();
  await importIndexAndSpyOnQueue();

  onCommand[0]("translate-page");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(tabsQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  expect(tabsSendMessage).toHaveBeenCalledWith(42, { type: "activate" });
});

it("falls back to tabs.query for the side panel when the command has no tab", async () => {
  const { onCommand, sidePanelOpen } = installChrome();
  await importIndexAndSpyOnQueue();

  onCommand[0]("toggle-side-panel");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 42 });
});

it("swallows a rejected active-tab query", async () => {
  const { onCommand, tabsQuery, tabsSendMessage } = installChrome();
  tabsQuery.mockRejectedValueOnce(new Error("no focused window"));
  await importIndexAndSpyOnQueue();

  expect(() => onCommand[0]("translate-page")).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(tabsSendMessage).not.toHaveBeenCalled();
});

it("swallows sendMessage rejections when no content script is listening", async () => {
  const { onCommand, tabsSendMessage } = installChrome();
  tabsSendMessage.mockRejectedValueOnce(new Error("Could not establish connection"));
  await importIndexAndSpyOnQueue();

  expect(() => onCommand[0]("translate-page", { id: 7, tab: { id: 7 } })).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("opens the options page for a trusted top-frame tab sender", async () => {
  const { onMessage, openOptionsPage } = installChrome();
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-options" }, { id: "test-extension-id", tab: { id: 9 }, frameId: 0 });

  expect(openOptionsPage).toHaveBeenCalledTimes(1);
});

it("opens the options page for an extension-page sender without a tab", async () => {
  const { onMessage, openOptionsPage } = installChrome();
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-options" }, { id: "test-extension-id" });

  expect(openOptionsPage).toHaveBeenCalledTimes(1);
});

it("ignores open-options from another extension", async () => {
  const { onMessage, openOptionsPage } = installChrome();
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-options" }, { id: "someone-else", tab: { id: 9 }, frameId: 0 });

  expect(openOptionsPage).not.toHaveBeenCalled();
});

it("ignores open-options from a non-top frame", async () => {
  const { onMessage, openOptionsPage } = installChrome();
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-options" }, { id: "test-extension-id", tab: { id: 9 }, frameId: 3 });

  expect(openOptionsPage).not.toHaveBeenCalled();
});

it("falls back to a tab when opening the options page rejects", async () => {
  const { onMessage, openOptionsPage, tabsCreate } = installChrome();
  openOptionsPage.mockRejectedValueOnce(new Error("no options page"));
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-options" }, { id: "test-extension-id", tab: { id: 9 }, frameId: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(tabsCreate).toHaveBeenCalledWith({
    url: "chrome-extension://test-extension-id/options.html",
  });
});

it("ignores open-chat from a non-top frame", async () => {
  const { onMessage, sidePanelOpen, storageSet } = installChrome();
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-chat", text: "x", mode: "explain" }, {
    id: "test-extension-id",
    tab: { id: 9 },
    frameId: 4,
  });

  expect(storageSet).not.toHaveBeenCalled();
  expect(sidePanelOpen).not.toHaveBeenCalled();
});

it("rejects the translate port from a non-top frame", async () => {
  const { onConnect } = installChrome();
  await importIndexAndSpyOnQueue();

  const port = fakePort("ilmt-translate", 42, 2);
  onConnect[0](port);

  expect(port.disconnect).toHaveBeenCalledTimes(1);
  expect(port.onMessage.addListener).not.toHaveBeenCalled();
  expect(port.disconnectListeners).toHaveLength(0);
});

it("rejects the chat port from a non-top frame", async () => {
  const { onConnect } = installChrome();
  await importIndexAndSpyOnQueue();

  const port = fakePort("ilmt-chat", 7, 1);
  onConnect[0](port);

  expect(port.disconnect).toHaveBeenCalledTimes(1);
  expect(port.onMessage.addListener).not.toHaveBeenCalled();
  expect(port.disconnectListeners).toHaveLength(0);
});

it("keeps the chat port working for a top-frame tab sender", async () => {
  const { onConnect } = installChrome();
  await importIndexAndSpyOnQueue();

  const port = fakePort("ilmt-chat", 7, 0);
  onConnect[0](port);

  expect(port.disconnect).not.toHaveBeenCalled();
  expect(port.onMessage.addListener).toHaveBeenCalledTimes(1);
});

it("falls back to a tab when openOptionsPage is unavailable", async () => {
  const { onMessage, tabsCreate } = installChrome();
  delete (globalThis as any).chrome.runtime.openOptionsPage;
  await importIndexAndSpyOnQueue();

  onMessage[0]({ type: "open-options" }, { id: "test-extension-id" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(tabsCreate).toHaveBeenCalledWith({
    url: "chrome-extension://test-extension-id/options.html",
  });
});
