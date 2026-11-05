/**
 * Pure side-panel session logic (spec §9). No DOM or `chrome.*` access — only
 * small immutable helpers, so the page-pinning and context-bounding behavior
 * stays trivially testable. `main.ts` owns rendering and the port wiring.
 */

import type { ChatContext, Session, SessionMessage } from "../shared/types";

/** Messages kept per session; the oldest are dropped past this (spec §9). */
const MAX_MESSAGES = 50;
/** Recent translated paragraphs included in the chat context (spec §8.9). */
const MAX_RECENT_PARAGRAPHS = 5;

let idCounter = 0;

/** Create a session pinned to the page where it started. */
export function createSession(pageUrl: string, pageTitle: string, tabId: number): Session {
  return {
    id: `s_${Date.now()}_${++idCounter}`,
    tabId,
    pageUrl,
    pageTitle,
    createdAt: Date.now(),
    messages: [],
  };
}

/** Append a message immutably, keeping at most the newest `MAX_MESSAGES`. */
export function appendMessage(s: Session, m: SessionMessage): Session {
  const messages = [...s.messages, m];
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
  }
  return { ...s, messages };
}

/** Build the page context from the session, the quotes and the recent paragraphs. */
export function buildChatContext(
  s: Session,
  quotes: string[],
  recentParagraphs: Array<{ source: string; translation: string }>,
): ChatContext {
  return {
    pageUrl: s.pageUrl,
    title: s.pageTitle,
    quotes: [...quotes],
    recentParagraphs: recentParagraphs.slice(-MAX_RECENT_PARAGRAPHS),
  };
}
