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
  (globalThis as any).chrome = {
    runtime: {
      id: "test-extension-id",
      onConnect: { addListener: (cb: Listener) => onConnect.push(cb) },
    },
    webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
    tabs: { onRemoved: { addListener: vi.fn() } },
  };
  return { onConnect };
}

function fakePort(name: string, tabId: number | undefined) {
  const disconnectListeners: Listener[] = [];
  return {
    name,
    sender: tabId === undefined ? { id: "test-extension-id" } : { id: "test-extension-id", tab: { id: tabId } },
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
