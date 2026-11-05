/**
 * Side-panel chat UI. Vanilla DOM only — no framework, no inline scripts.
 *
 * Owns the `ilmt-chat` port and the conversation state. Session logic lives in
 * `session.ts` (pure, tested); this file renders the state, wires the port, and
 * persists history under `chat.history`.
 *
 * The chat context references only translated paragraphs (see the fixed note
 * "只参考已翻译的段落"). There is no content-script API exposing translated
 * paragraphs yet, so `recentParagraphs` is always `[]` for now — the title/URL
 * and any selected quote still travel with each request.
 */

import { appendMessage, buildChatContext, createSession } from "./session";
import type {
  ChatBackgroundToClient,
  ChatClientToBackground,
  ChatContext,
  ChatMessage,
  Session,
  SessionMessage,
} from "../shared/types";
import cssText from "../styles/panel.css?inline";

const HISTORY_KEY = "chat.history";
const PENDING_QUOTE_KEY = "chat.pendingQuote";
const MAX_SESSIONS = 10;
const CONTEXT_NOTE = "只参考已翻译的段落";

/** Minimal port surface this module touches; defaulted to `chrome.runtime`. */
interface ChatPort {
  postMessage(message: ChatClientToBackground): void;
  onMessage: { addListener(listener: (message: ChatBackgroundToClient) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  disconnect(): void;
}

interface PendingQuote {
  text: string;
  mode: "explain" | "follow-up";
}

interface ActiveTab {
  id: number;
  url: string;
  title: string;
}

/**
 * TODO(T14): once the content script exposes its translated paragraphs, feed the
 * last five here so the chat context can reference them. Until then this stays
 * empty — never fabricate data or crawl the page.
 */
const recentParagraphs: Array<{ source: string; translation: string }> = [];

const scope = globalThis as typeof globalThis & {
  __ilmtPanel?: {
    ready: Promise<void>;
    session: Session | null;
    streaming: boolean;
  };
};

// --- module state ---
let started = false;
let session: Session | null = null;
let sessions: Session[] = [];
let port: ChatPort | null = null;
let currentRequestId: string | null = null;
let streaming = false;
let activeTab: ActiveTab | null = null;
let pendingQuote: PendingQuote | null = null;
let lastRequest: { text: string; quote?: string } | null = null;
let requestIdCounter = 0;

// --- DOM refs ---
let root: HTMLElement;
let msgList: HTMLElement;
let input: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let stopBtn: HTMLButtonElement;
let banner: HTMLElement;
let bannerTitle: HTMLElement;
let bannerButton: HTMLButtonElement;
let quoteChip: HTMLElement;
let quoteTextEl: HTMLElement;
let assistantEl: HTMLElement | null = null;

let resolveReady!: () => void;
const ready = new Promise<void>((resolve) => (resolveReady = resolve));
scope.__ilmtPanel = {
  ready,
  get session() {
    return session;
  },
  get streaming() {
    return streaming;
  },
};

export function runPanel(): Promise<void> {
  if (started) return ready;
  started = true;
  void start();
  return ready;
}

async function start(): Promise<void> {
  buildDom();
  injectStyles();
  sessions = await loadSessions();
  await consumePendingQuote();
  await refreshActiveTab();
  const tab = activeTab;
  session = findSession(sessions, tab?.id, tab?.url ?? "") ?? (tab ? createSession(tab.url, tab.title, tab.id) : createSession("", "", 0));
  renderAll();
  updateBanner();
  connectPort();
  wireTabs();
  resolveReady();
}

// --- DOM construction ---

function buildDom(): void {
  root = document.getElementById("root") ?? document.body;
  root.replaceChildren();

  const note = document.createElement("div");
  note.className = "context-note";
  note.textContent = CONTEXT_NOTE;
  root.appendChild(note);

  banner = document.createElement("div");
  banner.className = "banner";
  banner.hidden = true;
  bannerTitle = document.createElement("span");
  bannerTitle.className = "banner-title";
  bannerButton = document.createElement("button");
  bannerButton.type = "button";
  bannerButton.className = "banner-action";
  bannerButton.textContent = "针对新页面开新会话";
  bannerButton.addEventListener("click", handleNewSession);
  banner.append(bannerTitle, bannerButton);
  root.appendChild(banner);

  quoteChip = document.createElement("div");
  quoteChip.className = "quote-chip";
  quoteChip.hidden = true;
  quoteTextEl = document.createElement("span");
  quoteTextEl.className = "quote-chip-text";
  const quoteRemove = document.createElement("button");
  quoteRemove.type = "button";
  quoteRemove.className = "quote-chip-remove";
  quoteRemove.textContent = "×";
  quoteRemove.setAttribute("aria-label", "清除引用");
  quoteRemove.addEventListener("click", clearQuoteChip);
  quoteChip.append(quoteTextEl, quoteRemove);
  root.appendChild(quoteChip);

  msgList = document.createElement("div");
  msgList.className = "msg-list";
  root.appendChild(msgList);

  const composer = document.createElement("div");
  composer.className = "composer";
  input = document.createElement("textarea");
  input.className = "composer-input";
  input.placeholder = "输入问题…";
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });
  sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "composer-send";
  sendBtn.textContent = "发送";
  sendBtn.addEventListener("click", handleSend);
  stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "composer-stop";
  stopBtn.textContent = "停止";
  stopBtn.hidden = true;
  stopBtn.addEventListener("click", handleStop);
  composer.append(input, sendBtn, stopBtn);
  root.appendChild(composer);
}

function injectStyles(): void {
  if (document.querySelector("style[data-ilmt-panel]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-ilmt-panel", "");
  style.textContent = cssText;
  (document.head ?? document.documentElement).appendChild(style);
}

function renderAll(): void {
  msgList.replaceChildren();
  assistantEl = null;
  if (!session) return;
  for (const message of session.messages) {
    const el = renderMessage(message);
    msgList.appendChild(el);
    if (message.role === "assistant") assistantEl = el.querySelector(".msg-body");
  }
  msgList.scrollTop = msgList.scrollHeight;
}

function renderMessage(message: SessionMessage): HTMLElement {
  const el = document.createElement("div");
  el.className = `msg msg--${message.role}`;
  if (message.quote) {
    const quote = document.createElement("div");
    quote.className = "msg-quote";
    quote.textContent = message.quote;
    el.appendChild(quote);
  }
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = message.content;
  el.appendChild(body);
  return el;
}

// --- quoting ---

function showQuoteChip(): void {
  if (!pendingQuote) return;
  quoteTextEl.textContent = pendingQuote.text;
  quoteChip.hidden = false;
}

function clearQuoteChip(): void {
  pendingQuote = null;
  quoteTextEl.textContent = "";
  quoteChip.hidden = true;
}

async function consumePendingQuote(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(PENDING_QUOTE_KEY);
    const quote = stored[PENDING_QUOTE_KEY] as { text?: unknown; mode?: unknown } | undefined;
    if (quote && typeof quote.text === "string" && quote.text.trim() !== "") {
      pendingQuote = { text: quote.text, mode: quote.mode === "follow-up" ? "follow-up" : "explain" };
      showQuoteChip();
      input.value = pendingQuote.text;
    }
  } catch {
    // Unreadable storage: proceed without a pending quote.
  }
  try {
    await chrome.storage.local.remove(PENDING_QUOTE_KEY);
  } catch {
    // Best-effort clear; a stale quote is harmless.
  }
}

// --- active tab / page pinning ---

async function refreshActiveTab(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const first = tabs[0];
    if (first && first.id !== undefined) {
      activeTab = { id: first.id, url: first.url ?? "", title: first.title ?? "" };
      updateBanner();
    }
  } catch {
    // No active tab accessible: leave the banner state unchanged.
  }
}

function wireTabs(): void {
  chrome.tabs.onActivated.addListener(() => {
    void refreshActiveTab();
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
      void refreshActiveTab();
    }
  });
  // SPA history changes do not always surface as `tabs.onUpdated` URL changes.
  // The panel has the `webNavigation` permission, so it can observe the same
  // navigation signal the background forwards to content scripts.
  const nav = chrome.webNavigation;
  nav?.onCommitted?.addListener((details) => {
    if (details.frameId === 0) void refreshActiveTab();
  });
  nav?.onHistoryStateUpdated?.addListener((details) => {
    if (details.frameId === 0) void refreshActiveTab();
  });
}

/**
 * The session is still pinned to the active tab, but that tab has navigated to
 * a different URL. The conversation stays, yet its page context no longer
 * describes what the user is looking at.
 */
function isContextStale(): boolean {
  return (
    !!activeTab &&
    !!activeTab.url &&
    !!session &&
    session.pageUrl !== "" &&
    activeTab.id === session.tabId &&
    activeTab.url !== session.pageUrl
  );
}

function updateBanner(): void {
  const switched = !!activeTab && !!session && activeTab.id !== session.tabId;
  const stale = !switched && isContextStale();
  banner.hidden = !switched && !stale;
  if (switched) {
    const label = activeTab!.title || activeTab!.url;
    bannerTitle.textContent = label ? `当前页面已切换：${label}` : "当前页面已切换";
  } else if (stale) {
    bannerTitle.textContent = "上下文已失效";
  }
}

function handleNewSession(): void {
  const tab = activeTab;
  // Never swap sessions under an in-flight response: the new (empty) session
  // would swallow the remaining deltas and lose the partial answer.
  if (!tab || streaming) return;
  persistHistory();
  // In the stale state the tab still holds the old session id. Reusing it would
  // keep the panel pinned to a page the user has already left, so start a fresh
  // session against the page that is active now.
  const existing = isContextStale() ? null : findSession(sessions, tab.id, tab.url);
  session = existing ?? createSession(tab.url, tab.title, tab.id);
  renderAll();
  updateBanner();
}

// --- send / stream / abort ---

function handleSend(): void {
  const text = input.value.trim();
  const quote = pendingQuote?.text;
  if (!text || streaming) return;
  clearQuoteChip();
  input.value = "";
  sendText(text, quote);
}

function sendText(text: string, quote?: string): void {
  if (!session || streaming) return;
  lastRequest = { text, quote };
  const now = Date.now();
  session = appendMessage(session, { role: "user", content: text, quote, ts: now });
  const messages: ChatMessage[] = session.messages.map((m) => ({ role: m.role, content: m.content }));
  // Once the pinned page navigates away, never keep injecting the old page's
  // title/URL/paragraphs. The conversation itself is preserved.
  const context: ChatContext = isContextStale()
    ? { pageUrl: "", title: "", quotes: quote ? [quote] : [], recentParagraphs: [] }
    : buildChatContext(session, quote ? [quote] : [], recentParagraphs);
  session = appendMessage(session, { role: "assistant", content: "", ts: now + 1 });
  renderAll();
  persistHistory();

  const requestId = newRequestId();
  currentRequestId = requestId;
  streaming = true;
  setInputEnabled(false);

  send({ type: "chat", requestId, sessionId: session.id, messages, context });
}

function handleStop(): void {
  const requestId = currentRequestId;
  if (!requestId) return;
  currentRequestId = null;
  streaming = false;
  assistantEl = null;
  send({ type: "abort", requestId });
  persistHistory();
  showError("已中断，重新发送", "重新发送");
  setInputEnabled(true);
}

function handleRetry(): void {
  removeError();
  const request = lastRequest;
  if (!request) return;
  sendText(request.text, request.quote);
}

function setInputEnabled(enabled: boolean): void {
  input.disabled = !enabled;
  sendBtn.hidden = !enabled;
  stopBtn.hidden = enabled;
}

function showError(message: string, actionLabel: string): void {
  removeError();
  const el = document.createElement("div");
  el.className = "error-block";
  const text = document.createElement("span");
  text.className = "error-text";
  text.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "error-retry";
  retry.textContent = actionLabel;
  retry.addEventListener("click", handleRetry);
  el.append(text, retry);
  msgList.appendChild(el);
  msgList.scrollTop = msgList.scrollHeight;
}

function removeError(): void {
  msgList.querySelectorAll(".error-block").forEach((el) => el.remove());
}

// --- port routing ---

function connectPort(): void {
  try {
    port = chrome.runtime.connect({ name: "ilmt-chat" }) as unknown as ChatPort;
    port.onMessage.addListener(route);
    port.onDisconnect.addListener(handleDisconnect);
  } catch {
    port = null;
  }
}

function send(message: ChatClientToBackground): void {
  if (!port) connectPort();
  if (!port) {
    handleConnectionError();
    return;
  }
  try {
    port.postMessage(message);
  } catch {
    handleConnectionError();
  }
}

function route(raw: ChatBackgroundToClient): void {
  switch (raw.type) {
    case "delta":
      handleDelta(raw);
      break;
    case "finish":
      handleFinish(raw);
      break;
    case "error":
      handleError(raw);
      break;
    default:
      break;
  }
}

function handleDelta(message: Extract<ChatBackgroundToClient, { type: "delta" }>): void {
  if (message.requestId !== currentRequestId || !session) return;
  const last = session.messages.at(-1);
  if (!last || last.role !== "assistant") return;
  const content = last.content + message.text;
  session = replaceLastMessage(session, content);
  if (assistantEl) assistantEl.textContent = content;
}

function handleFinish(message: Extract<ChatBackgroundToClient, { type: "finish" }>): void {
  if (message.requestId !== currentRequestId) return;
  currentRequestId = null;
  streaming = false;
  assistantEl = null;
  persistHistory();
  setInputEnabled(true);
}

function handleError(message: Extract<ChatBackgroundToClient, { type: "error" }>): void {
  if (message.requestId !== currentRequestId) return;
  currentRequestId = null;
  streaming = false;
  assistantEl = null;
  persistHistory();
  showError(message.message, "重新发送");
  setInputEnabled(true);
}

function handleDisconnect(): void {
  port = null;
  if (!streaming) return;
  streaming = false;
  currentRequestId = null;
  assistantEl = null;
  persistHistory();
  showError("已中断，重新发送", "重新发送");
  setInputEnabled(true);
}

function handleConnectionError(): void {
  if (!streaming) return;
  streaming = false;
  currentRequestId = null;
  assistantEl = null;
  showError("连接失败", "重新发送");
  setInputEnabled(true);
}

// --- history persistence ---

async function loadSessions(): Promise<Session[]> {
  try {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const value = stored[HISTORY_KEY];
    if (Array.isArray(value)) return value.filter(isSession);
  } catch {
    // Unreadable storage: start with no history.
  }
  return [];
}

function persistHistory(): void {
  if (!session || session.messages.length === 0) return;
  upsertSession(session);
  chrome.storage.local.set({ [HISTORY_KEY]: sessions }).catch(() => {});
}

/** Insert/update the session at the front of the list and prune the oldest. */
function upsertSession(s: Session): void {
  const rest = sessions.filter((x) => x.id !== s.id);
  sessions = [s, ...rest].slice(0, MAX_SESSIONS);
}

// --- small helpers ---

function findSession(list: Session[], tabId: number | undefined, pageUrl: string): Session | null {
  if (tabId === undefined) return null;
  return list.find((s) => s.tabId === tabId && s.pageUrl === pageUrl) ?? null;
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return typeof s.id === "string" && typeof s.tabId === "number" && Array.isArray(s.messages);
}

function replaceLastMessage(s: Session, content: string): Session {
  const messages = s.messages.slice();
  const last = messages.at(-1);
  if (!last) return s;
  messages[messages.length - 1] = { ...last, content };
  return { ...s, messages };
}

function newRequestId(): string {
  return `c_${Date.now()}_${++requestIdCounter}`;
}

// Auto-run on load.
void runPanel();
