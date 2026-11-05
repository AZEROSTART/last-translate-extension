/**
 * Background service worker entry: port routing, command shortcuts, SPA
 * navigation notifications, side-panel behavior and tab cleanup. All
 * provider/prompt/queue logic lives in `dispatch.ts`; this file only wires
 * chrome events to it.
 */

import { createDeps, handleChat, handleTranslate } from "./dispatch";
import type {
  BackgroundToClient,
  ChatBackgroundToClient,
  ChatClientToBackground,
  ClientToBackground,
  ContentRuntimeMessage,
  OpenChatMessage,
} from "../shared/types";

const deps = createDeps();

/** Storage key where a pending selection quote waits for the panel to read it. */
const PENDING_QUOTE_KEY = "chat.pendingQuote";

/** Only the window the user last interacted with has a meaningful active tab. */
const ACTIVE_TAB_QUERY: chrome.tabs.QueryInfo = { active: true, lastFocusedWindow: true };

/**
 * Toolbar clicks open the side panel without content-script help (spec §8.9).
 * Register it at startup, not only on install: a service-worker restart must
 * not lose the behavior. Failures are non-fatal in every Chrome version.
 */
try {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      // Older Chrome or a missing permission; the panel shortcut still works.
    });
} catch {
  // `setPanelBehavior` may be unavailable; never break the worker import.
}

/**
 * Resolve the active tab in the last focused window. A missing tab (or a
 * rejected query) simply makes the command a no-op.
 */
async function activeTabId(): Promise<number | undefined> {
  try {
    const tabs = await chrome.tabs.query(ACTIVE_TAB_QUERY);
    return tabs[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * Deliver a runtime message to a tab's content script. There may be no receiver
 * (chrome:// pages, the guard failed to load), which Chrome reports as a
 * rejected promise; that is expected and must stay silent.
 */
function sendToTab(tabId: number, message: ContentRuntimeMessage): void {
  try {
    void chrome.tabs.sendMessage(tabId, message).catch(() => {
      // No content script in this tab.
    });
  } catch {
    // Synchronous sendMessage failure; same expected no-receiver case.
  }
}

/**
 * Prefer the tab Chrome hands to the command listener: it needs no async
 * lookup, so the command reacts immediately. The query fallback only covers
 * hosts/versions that omit the second argument.
 */
function sendToCommandTab(tab: chrome.tabs.Tab | undefined, message: ContentRuntimeMessage): void {
  if (tab?.id !== undefined) {
    sendToTab(tab.id, message);
    return;
  }
  void activeTabId().then((tabId) => {
    if (tabId !== undefined) sendToTab(tabId, message);
  });
}

/**
 * Open the side panel for a tab. This must run synchronously inside the
 * command listener: `sidePanel.open` requires the command's user gesture, and
 * an `await`/promise hop loses it.
 */
function openSidePanelForTab(tabId: number): void {
  try {
    void chrome.sidePanel.open({ tabId }).catch(() => {
      // The gesture expired or the panel is unavailable.
    });
  } catch {
    // Synchronous failure outside a user gesture.
  }
}

function openSidePanelForCommandTab(tab: chrome.tabs.Tab | undefined): void {
  if (tab?.id !== undefined) {
    openSidePanelForTab(tab.id);
    return;
  }
  void activeTabId().then((tabId) => {
    if (tabId !== undefined) openSidePanelForTab(tabId);
  });
}

/**
 * Command shortcuts (spec §10). `translate-page` activates the content main
 * through the guard; `ask-selection` asks it to explain the current selection;
 * `toggle-side-panel` opens the panel (the command event carries a user
 * gesture, which `sidePanel.open` requires).
 */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "translate-page") {
    sendToCommandTab(tab, { type: "activate" });
  } else if (command === "ask-selection") {
    sendToCommandTab(tab, { type: "ask-selection" });
  } else if (command === "toggle-side-panel") {
    openSidePanelForCommandTab(tab);
  }
});

/**
 * Content scripts ask for the side panel by sending `open-chat` (a runtime
 * message, not a port message). Stash the selection under `chat.pendingQuote`
 * so the panel can pre-fill its quote chip, then open the panel for the sender's
 * tab. `sidePanel.open` requires a user gesture and may reject; that failure
 * must never surface to the page.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender: chrome.runtime.MessageSender) => {
  if (!message || typeof message !== "object") return;
  const msg = message as { type?: unknown };
  if (msg.type !== "open-chat") return;
  if (sender.id !== chrome.runtime.id) return;

  const openChat = message as OpenChatMessage;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  void chrome.storage.local
    .set({ [PENDING_QUOTE_KEY]: { text: openChat.text, mode: openChat.mode, tabId, ts: Date.now() } })
    .catch(() => {
      // Storage write failed; the panel just opens without a pre-filled quote.
    });

  try {
    void chrome.sidePanel.open({ tabId }).catch(() => {
      // No user gesture (or panel already open): ignore, never throw to the page.
    });
  } catch {
    // `sidePanel.open` can throw synchronously outside a user gesture.
  }
});

chrome.runtime.onConnect.addListener((port) => {
  // Reject any connection not from this extension (spec §12).
  if (!deps.isTrustedSender(port.sender ?? {})) {
    port.disconnect();
    return;
  }

  if (port.name === "ilmt-translate") {
    // requestId → owning tab, so an `abort` can cancel the whole tab.
    const tabByRequest = new Map<string, number>();
    const senderTabId = port.sender?.tab?.id;

    port.onMessage.addListener((raw: ClientToBackground) => {
      if (!deps.isTrustedSender(port.sender ?? {})) return;

      if (raw.type === "translate") {
        // `sender.tab.id` is authoritative; the message's tabId is only a
        // fallback, so the queue task and the abort mapping share one id.
        const tabId = port.sender?.tab?.id ?? raw.tabId;
        tabByRequest.set(raw.requestId, tabId);
        void handleTranslate(deps, { ...raw, tabId }, (m: BackgroundToClient) => port.postMessage(m)).catch(
          logUnexpected,
        );
      } else if (raw.type === "abort") {
        const tabId = tabByRequest.get(raw.requestId);
        if (tabId !== undefined) deps.queue.cancelTab(tabId);
      } else if (raw.type === "ping") {
        port.postMessage({ type: "pong" } satisfies BackgroundToClient);
      }
    });

    // A killed port must cancel the tab's work even when the content script's
    // `abort` never arrived (tab close, reload, service-worker teardown). The
    // content side also defers `close()` one macrotask so `abort` wins first.
    port.onDisconnect.addListener(() => {
      if (senderTabId !== undefined) deps.queue.cancelTab(senderTabId);
    });
  } else if (port.name === "ilmt-chat") {
    const tabByRequest = new Map<string, number>();
    const senderTabId = port.sender?.tab?.id;

    port.onMessage.addListener((raw: ChatClientToBackground) => {
      if (!deps.isTrustedSender(port.sender ?? {})) return;

      if (raw.type === "chat") {
        const tabId = port.sender?.tab?.id ?? 0;
        tabByRequest.set(raw.requestId, tabId);
        void handleChat(deps, raw, (m: ChatBackgroundToClient) => port.postMessage(m), tabId).catch(logUnexpected);
      } else if (raw.type === "abort") {
        const tabId = tabByRequest.get(raw.requestId);
        if (tabId !== undefined) deps.queue.cancelTab(tabId);
      }
    });

    port.onDisconnect.addListener(() => {
      if (senderTabId !== undefined) deps.queue.cancelTab(senderTabId);
    });
  }
});

// SPA route changes reach the content script via tabs.sendMessage, never
// through the translate port (Ruling 8). Only the main frame is relevant.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs
    .sendMessage(details.tabId, { type: "page-navigated" } satisfies BackgroundToClient)
    .catch(() => {
      // No receiver (content script not injected) is expected.
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  deps.queue.cancelTab(tabId);
});

/**
 * Contain an unexpected top-level dispatch failure so it cannot surface as an
 * unhandled service-worker rejection. Log the message only — never headers or
 * keys, which the dispatch layer already redacts.
 */
function logUnexpected(err: unknown): void {
  console.error("ilmt dispatch failed:", err instanceof Error ? err.message : String(err));
}
