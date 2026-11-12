/**
 * Background service worker entry: port routing, command shortcuts, SPA
 * navigation notifications, side-panel behavior and tab cleanup. All
 * provider/prompt/queue logic lives in `dispatch.ts`; this file only wires
 * chrome events to it.
 */

import { createDeps, handleChat, handleTranslate } from "./dispatch";
import { handleLearningMessage, isLearningMessageType } from "./learning";
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

/** Page context-menu entry that starts the same flow as the translate command. */
const TRANSLATE_PAGE_MENU_ID = "translate-page";

/**
 * Register the translate-page context menu. Menus survive service-worker
 * restarts, so registration belongs to `onInstalled` (install and update),
 * not the top level; `removeAll` keeps a reload from failing on a duplicate id.
 * Use `all` rather than `page`: Chrome scopes `page` to clicks where no other
 * context applies, so right-clicking a link, image, selection or editable
 * element would otherwise hide the item.
 */
function registerTranslateContextMenu(): void {
  const create = (): void => {
    try {
      chrome.contextMenus.create(
        { id: TRANSLATE_PAGE_MENU_ID, title: "翻译当前页面", contexts: ["all"] },
        () => {
          // Duplicate ids after a reload are harmless; reading lastError keeps
          // Chrome from logging an unchecked-error warning.
          void chrome.runtime.lastError;
        },
      );
    } catch {
      // Context menus unavailable; never break the service worker.
    }
  };

  try {
    chrome.contextMenus.removeAll(() => create());
  } catch {
    create();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  registerTranslateContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== TRANSLATE_PAGE_MENU_ID) return;
  sendToCommandTab(tab, { type: "activate" });
});

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
 * Only this extension may drive the background (spec §12), and content-script
 * senders must be the top frame. Extension pages and the service worker have no
 * `tab`, so they stay trusted; tab senders that expose a `frameId` must be 0.
 */
function isTrustedSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!deps.isTrustedSender(sender ?? {})) return false;
  if (sender?.tab !== undefined && sender.frameId !== undefined && sender.frameId !== 0) return false;
  return true;
}

/**
 * Chrome reports a port closed by a page entering back/forward cache through
 * `runtime.lastError`. The disconnect is expected, but Chrome logs an
 * "Unchecked runtime.lastError" entry unless the callback reads it.
 */
function consumePortLastError(): void {
  void chrome.runtime.lastError;
}

/**
 * Open the popup settings. `action.openPopup` is the preferred path; when the
 * Chrome version or the user-gesture requirement blocks it, open the same UI in
 * a normal tab via `popup.html?mode=page`.
 */
function openSettings(): void {
  try {
    if (typeof chrome.action?.openPopup !== "function") {
      createSettingsTab();
      return;
    }
    const opening = chrome.action.openPopup();
    if (opening && typeof opening.catch === "function") {
      void opening.catch(() => createSettingsTab());
    }
    return;
  } catch {
    // Older Chrome or a restricted context; use the tab fallback.
  }
  createSettingsTab();
}

function createSettingsTab(): void {
  try {
    void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=page") }).catch(() => {
      // Nowhere to open the page; never surface this to the sender.
    });
  } catch {
    // Synchronous failure; swallow it for the same reason.
  }
}

/**
 * Content scripts ask for the side panel by sending `open-chat` (a runtime
 * message, not a port message) and for settings via `open-options`. Stash the
 * selection under `chat.pendingQuote` so the panel can pre-fill its quote chip,
 * then open the panel for the sender's tab. `sidePanel.open` requires a user
 * gesture and may reject; that failure must never surface to the page.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender: chrome.runtime.MessageSender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const msg = message as { type?: unknown };

  // Learning writes are serialized in the background; answer asynchronously.
  if (isLearningMessageType(msg.type)) {
    if (!isTrustedSender(sender)) return;
    void handleLearningMessage(message)
      .then((result) => sendResponse(result ?? undefined))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type !== "open-chat" && msg.type !== "open-options") return;
  if (!isTrustedSender(sender)) return;

  if (msg.type === "open-options") {
    openSettings();
    return;
  }

  const openChat = message as OpenChatMessage;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  void chrome.storage.local
    .set({
      [PENDING_QUOTE_KEY]: {
        text: openChat.text,
        mode: openChat.mode,
        tabId,
        ts: Date.now(),
        ...(openChat.context ? { context: openChat.context } : {}),
      },
    })
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
  // Reject any connection not from this extension's top frame (spec §12).
  if (!isTrustedSender(port.sender)) {
    port.disconnect();
    return;
  }

  if (port.name === "ilmt-translate") {
    // requestId → owning tab, so an `abort` can cancel the whole tab.
    const tabByRequest = new Map<string, number>();
    const senderTabId = port.sender?.tab?.id;

    port.onMessage.addListener((raw: ClientToBackground) => {
      if (!isTrustedSender(port.sender)) return;

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
      consumePortLastError();
      if (senderTabId !== undefined) deps.queue.cancelTab(senderTabId);
    });
  } else if (port.name === "ilmt-chat") {
    const tabByRequest = new Map<string, number>();
    const senderTabId = port.sender?.tab?.id;

    port.onMessage.addListener((raw: ChatClientToBackground) => {
      if (!isTrustedSender(port.sender)) return;

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
      consumePortLastError();
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
