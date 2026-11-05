/**
 * Background service worker entry: port routing, SPA navigation notifications,
 * and tab cleanup. All provider/prompt/queue logic lives in `dispatch.ts`;
 * this file only wires chrome events to it.
 */

import { createDeps, handleChat, handleTranslate } from "./dispatch";
import type {
  BackgroundToClient,
  ChatBackgroundToClient,
  ChatClientToBackground,
  ClientToBackground,
} from "../shared/types";

const deps = createDeps();

chrome.runtime.onConnect.addListener((port) => {
  // Reject any connection not from this extension (spec §12).
  if (!deps.isTrustedSender(port.sender ?? {})) {
    port.disconnect();
    return;
  }

  if (port.name === "ilmt-translate") {
    // requestId → owning tab, so an `abort` can cancel the whole tab.
    const tabByRequest = new Map<string, number>();

    port.onMessage.addListener((raw: ClientToBackground) => {
      if (!deps.isTrustedSender(port.sender ?? {})) return;

      if (raw.type === "translate") {
        // `sender.tab.id` is authoritative; the message's tabId is only a
        // fallback, so the queue task and the abort mapping share one id.
        const tabId = port.sender?.tab?.id ?? raw.tabId;
        tabByRequest.set(raw.requestId, tabId);
        void handleTranslate(deps, { ...raw, tabId }, (m: BackgroundToClient) => port.postMessage(m));
      } else if (raw.type === "abort") {
        const tabId = tabByRequest.get(raw.requestId);
        if (tabId !== undefined) deps.queue.cancelTab(tabId);
      } else if (raw.type === "ping") {
        port.postMessage({ type: "pong" } satisfies BackgroundToClient);
      }
    });
  } else if (port.name === "ilmt-chat") {
    const tabByRequest = new Map<string, number>();

    port.onMessage.addListener((raw: ChatClientToBackground) => {
      if (!deps.isTrustedSender(port.sender ?? {})) return;

      if (raw.type === "chat") {
        const tabId = port.sender?.tab?.id ?? 0;
        tabByRequest.set(raw.requestId, tabId);
        void handleChat(deps, raw, (m: ChatBackgroundToClient) => port.postMessage(m), tabId);
      } else if (raw.type === "abort") {
        const tabId = tabByRequest.get(raw.requestId);
        if (tabId !== undefined) deps.queue.cancelTab(tabId);
      }
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
