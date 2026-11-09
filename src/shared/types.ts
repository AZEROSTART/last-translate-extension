/**
 * Shared type vocabulary for the extension. Types only — no runtime logic here.
 */

/** How a provider is configured: a native preset or a user-supplied endpoint. */
export type ProviderKind = "custom" | "deepseek";

/** A user-configured OpenAI-compatible provider (spec §8.6). */
export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
  /** Append `/v1` when the URL does not already end with it. Absence = true. */
  appendV1?: boolean;
  extraHeaders?: Record<string, string>;
  overrides?: {
    concurrency?: number;
    maxRPS?: number;
    temperature?: number;
    systemPrompt?: string;
  };
  createdAt: number;
  lastUsedAt?: number;
}

/** Persisted global settings (spec §9). */
export interface Settings {
  providers: ProviderConfig[];
  activeProviderId: string;
  targetLang: string;
  concurrency: number;
  maxRPS: number;
  temperature: number;
  systemPrompt: string;
  promptVersion: string;
  triggerMode: "shortcut" | "auto-current-site";
  siteRules: Record<string, "auto" | "never">;
  theme: "system" | "light" | "dark";
}

/** Per-paragraph translation state machine (spec §8.4). */
export type ParagraphStatus = "unseen" | "queued" | "inflight" | "done" | "failed" | "skipped";

/** A paragraph queued for translation (spec §8.11). */
export interface TranslateItem {
  id: string;
  text: string;
  hash: string;
}

/** Normalized provider error codes (spec §8.6). */
export type ErrorCode =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "bad_response"
  | "aborted"
  | "unknown";

/** A model returned by `GET {baseURL}/models`. */
export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

/** A single chat message sent to an OpenAI-compatible endpoint. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Page context supplied to side-panel chat (spec §8.9). */
export interface ChatContext {
  pageUrl: string;
  title: string;
  quotes: string[];
  recentParagraphs: Array<{ source: string; translation: string }>;
}

/** A persisted side-panel message (spec §9). */
export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  quote?: string;
  ts: number;
}

/** A side-panel conversation pinned to the page where it started (spec §9). */
export interface Session {
  id: string;
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  createdAt: number;
  messages: SessionMessage[];
}

/** Messages sent from the content script to the background translate port. */
export type ClientToBackground =
  | { type: "translate"; requestId: string; tabId: number; items: TranslateItem[] }
  | { type: "abort"; requestId: string }
  | { type: "ping" };

/** Messages sent from the background translate port back to the content script. */
export type BackgroundToClient =
  | { type: "delta"; requestId: string; id: string; text: string }
  | { type: "result"; requestId: string; items: Array<{ id: string; text: string }> }
  | { type: "error"; requestId: string; code: ErrorCode; message: string; retryable: boolean; ids: string[] }
  | { type: "finish"; requestId: string }
  | { type: "pong" }
  | { type: "page-navigated" };

/** Trusted runtime messages that ask the content script to start work. */
export interface ActivateMessage {
  type: "activate";
}

export interface AskSelectionMessage {
  type: "ask-selection";
}

export type ContentRuntimeMessage = ActivateMessage | AskSelectionMessage;

/** Ask the content script for its most recent finished translations. */
export interface RecentTranslationsMessage {
  type: "get-recent-translations";
}

export interface RecentTranslationsResponse {
  paragraphs: Array<{ source: string; translation: string }>;
}

/** Ask the background to open the extension options page (error banner action). */
export interface OpenOptionsMessage {
  type: "open-options";
}

/** Messages sent from the side panel to the background chat port. */
export type ChatClientToBackground =
  | { type: "chat"; requestId: string; sessionId: string; messages: ChatMessage[]; context: ChatContext }
  | { type: "abort"; requestId: string };

/** Messages sent from the background chat port back to the side panel. */
export type ChatBackgroundToClient =
  | { type: "delta"; requestId: string; text: string }
  | { type: "finish"; requestId: string; usage?: ChatUsage }
  | { type: "error"; requestId: string; code: ErrorCode; message: string; retryable: boolean };

/** Token usage reported when a chat response finishes. */
export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Runtime message the content script sends (via `chrome.runtime.sendMessage`)
 * to ask the background to open the side panel with a selected quote. A runtime
 * message, not a port message.
 */
export interface OpenChatMessage {
  type: "open-chat";
  text: string;
  mode: "explain" | "follow-up";
}
