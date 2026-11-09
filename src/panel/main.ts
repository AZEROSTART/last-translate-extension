/**
 * Side-panel chat UI. Vanilla DOM only — no framework, no inline scripts.
 *
 * Owns the `ilmt-chat` port and the conversation state. Session logic lives in
 * `session.ts` (pure, tested); this file renders the state, wires the port, and
 * persists history under `chat.history`.
 *
 * The chat context references only translated paragraphs (see the fixed note
 * "只参考已翻译的段落"). The content script answers `get-recent-translations`
 * with its last finished records; a failed/slow fetch degrades to no paragraphs
 * rather than blocking the conversation.
 */

import { appendMessage, buildChatContext, createSession } from "./session";
import { getSettings, saveSettings } from "../shared/storage";
import type {
  ChatBackgroundToClient,
  ChatClientToBackground,
  ChatContext,
  ChatMessage,
  ErrorCode,
  OpenOptionsMessage,
  RecentTranslationsMessage,
  Session,
  SessionMessage,
  Settings,
} from "../shared/types";
import cssText from "../styles/panel.css?inline";
import themeCss from "../styles/theme.css?inline";

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

type RecentParagraph = { source: string; translation: string };

/** How long the panel waits for the content script before sending anyway. */
const RECENT_TIMEOUT_MS = 500;
const EXPLAIN_QUESTION = "这是什么意思？";
const CHINESE_ERRORS: Record<ErrorCode, string> = {
  auth: "鉴权失败，请检查 API key",
  rate_limit: "请求过于频繁，请稍后重试",
  timeout: "请求超时",
  network: "网络错误",
  bad_response: "模型返回异常",
  aborted: "已取消",
  unknown: "请求失败",
};

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
let panelSettings: Settings | null = null;
let requestIdCounter = 0;
let thinkingEnabled = false;

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
let providerSelect: HTMLSelectElement;
let providerModel: HTMLElement;
let thinkingToggle: HTMLLabelElement;
let thinkingInput: HTMLInputElement;
let providerSettingsBtn: HTMLButtonElement;
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
  document.documentElement.dataset.theme = "quantum";
  buildDom();
  injectStyles();
  await loadPanelSettings();
  sessions = await loadSessions();
  const quote = await readPendingQuote();
  await refreshActiveTab();
  const tab = activeTab;
  session = findSession(sessions, tab?.id, tab?.url ?? "") ?? (tab ? createSession(tab.url, tab.title, tab.id) : createSession("", "", 0));
  renderAll();
  updateBanner();
  connectPort();
  wireTabs();
  wireStorage();
  applyPendingQuote(quote);
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

  const providerBar = document.createElement("div");
  providerBar.className = "provider-bar";
  providerSelect = document.createElement("select");
  providerSelect.className = "provider-select";
  providerSelect.setAttribute("aria-label", "选择模型提供商");
  providerSelect.addEventListener("change", handleProviderChange);
  providerModel = document.createElement("span");
  providerModel.className = "provider-model";

  thinkingToggle = document.createElement("label");
  thinkingToggle.className = "thinking-toggle";
  thinkingToggle.hidden = true;
  thinkingToggle.title = "仅影响聊天；默认关闭";

  thinkingInput = document.createElement("input");
  thinkingInput.type = "checkbox";
  thinkingInput.className = "thinking-input";
  thinkingInput.checked = false;
  thinkingInput.addEventListener("change", () => {
    thinkingEnabled = thinkingInput.checked;
  });

  const thinkingText = document.createElement("span");
  thinkingText.textContent = "思考模式";
  thinkingToggle.append(thinkingInput, thinkingText);

  providerSettingsBtn = document.createElement("button");
  providerSettingsBtn.type = "button";
  providerSettingsBtn.className = "provider-settings";
  providerSettingsBtn.textContent = "设置";
  providerSettingsBtn.hidden = true;
  providerSettingsBtn.addEventListener("click", handleOpenOptions);
  providerBar.append(providerSelect, providerModel, thinkingToggle, providerSettingsBtn);
  root.appendChild(providerBar);

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
  style.textContent = themeCss + cssText;
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

// --- provider switcher (spec §8.9) ---

async function loadPanelSettings(): Promise<void> {
  try {
    panelSettings = await getSettings();
  } catch {
    panelSettings = null;
  }
  renderProviderBar();
}

function renderProviderBar(): void {
  const providers = panelSettings?.providers ?? [];
  if (providers.length === 0) {
    providerSelect.replaceChildren();
    providerSelect.hidden = true;
    providerSettingsBtn.hidden = false;
    providerModel.textContent = "尚未配置模型";
    thinkingToggle.hidden = true;
    return;
  }

  const configured = panelSettings?.activeProviderId ?? "";
  const activeId = providers.some((provider) => provider.id === configured)
    ? configured
    : providers[0].id;

  const options = providers.map((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name || provider.id;
    return option;
  });
  providerSelect.replaceChildren(...options);
  providerSelect.value = activeId;
  providerSelect.hidden = false;
  providerSettingsBtn.hidden = true;

  const active = providers.find((provider) => provider.id === activeId);
  providerModel.textContent = active?.model ?? "";
  thinkingToggle.hidden = active?.kind !== "deepseek";
  thinkingInput.checked = thinkingEnabled;
}

function handleProviderChange(): void {
  if (!panelSettings) return;
  const provider = panelSettings.providers.find((candidate) => candidate.id === providerSelect.value);
  if (!provider) return;

  panelSettings = { ...panelSettings, activeProviderId: provider.id };
  // Update the read-only label immediately; the write is best-effort.
  providerModel.textContent = provider.model;
  void saveSettings(panelSettings).catch(() => {
    void refreshSettingsFromStorage();
  });
}

async function refreshSettingsFromStorage(): Promise<void> {
  try {
    panelSettings = await getSettings();
  } catch {
    return;
  }
  renderProviderBar();
}

function handleOpenOptions(): void {
  try {
    const pending = chrome.runtime.sendMessage({ type: "open-options" } satisfies OpenOptionsMessage);
    if (pending && typeof pending.catch === "function") {
      void pending.catch(() => {});
    }
  } catch {
    // Nothing to open; never surface this in the panel.
  }
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

function parsePendingQuote(value: unknown): PendingQuote | null {
  if (!value || typeof value !== "object") return null;
  const quote = value as { text?: unknown; mode?: unknown };
  if (typeof quote.text !== "string" || quote.text.trim() === "") return null;
  return { text: quote.text, mode: quote.mode === "follow-up" ? "follow-up" : "explain" };
}

async function readPendingQuote(): Promise<PendingQuote | null> {
  let quote: PendingQuote | null = null;
  try {
    const stored = await chrome.storage.local.get(PENDING_QUOTE_KEY);
    quote = parsePendingQuote(stored[PENDING_QUOTE_KEY]);
  } catch {
    // Unreadable storage: proceed without a pending quote.
  }
  try {
    await chrome.storage.local.remove(PENDING_QUOTE_KEY);
  } catch {
    // Best-effort clear; a stale quote is harmless.
  }
  return quote;
}

/**
 * Explain requests are sent immediately; follow-ups become an editable
 * composer prefill. When the panel has no live session/tab (or is busy) the
 * quote is offered as a prefill rather than dropped.
 */
function applyPendingQuote(quote: PendingQuote | null): void {
  if (!quote) return;

  const canAutoSend =
    !!session &&
    !!activeTab &&
    session.tabId > 0 &&
    activeTab.id === session.tabId &&
    !streaming;

  if (quote.mode === "explain" && canAutoSend) {
    clearQuoteChip();
    input.value = "";
    void sendRequest({ text: EXPLAIN_QUESTION, quote: quote.text, appendUser: true });
    return;
  }

  pendingQuote = { text: quote.text, mode: quote.mode };
  showQuoteChip();
  input.value = quote.text;
}

function wireStorage(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    const pending = changes[PENDING_QUOTE_KEY];
    if (pending) {
      const quote = parsePendingQuote(pending.newValue);
      if (quote) {
        void chrome.storage.local
          .remove(PENDING_QUOTE_KEY)
          .catch(() => {
            // A stale quote is harmless; never leave the panel blocked.
          });
        applyPendingQuote(quote);
      }
    }

    if (changes.settings) void refreshSettingsFromStorage();
  });
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
  bannerButton.disabled = streaming;
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
  void sendRequest({ text, quote, appendUser: true });
}

interface SendRequestOptions {
  text: string;
  quote?: string;
  /** Retry keeps the existing user turn; a fresh send appends one. */
  appendUser: boolean;
}

async function sendRequest(options: SendRequestOptions): Promise<void> {
  const { text, quote, appendUser } = options;
  if (!session || streaming) return;

  const now = Date.now();
  // Set the guard before the first await so a double click cannot start a
  // second request while the recent-paragraph fetch is pending.
  streaming = true;
  lastRequest = { text, quote };
  setInputEnabled(false);

  if (appendUser) {
    session = appendMessage(session, { role: "user", content: text, quote, ts: now });
  }
  renderAll();
  persistHistory();

  // Once the pinned page navigates away, never keep injecting the old page's
  // title/URL/paragraphs. The conversation itself is preserved.
  const recentParagraphs = isContextStale() ? [] : await fetchRecentParagraphs(session.tabId);

  const messages: ChatMessage[] = session.messages.map((m) => ({ role: m.role, content: m.content }));
  const context: ChatContext = isContextStale()
    ? { pageUrl: "", title: "", quotes: quote ? [quote] : [], recentParagraphs: [] }
    : buildChatContext(session, quote ? [quote] : [], recentParagraphs);
  session = appendMessage(session, { role: "assistant", content: "", ts: now + 1 });
  renderAll();
  persistHistory();

  const requestId = newRequestId();
  currentRequestId = requestId;

  send({ type: "chat", requestId, sessionId: session.id, messages, context, thinking: thinkingEnabled });
}

/**
 * Ask the loaded content script for its last finished translations. A missing
 * receiver, a slow answer, or a malformed payload all degrade to an empty list
 * so chat never waits on page state.
 */
function fetchRecentParagraphs(tabId: number): Promise<RecentParagraph[]> {
  if (tabId <= 0) return Promise.resolve([]);

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finish = (paragraphs: RecentParagraph[]): void => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve(paragraphs);
    };

    timeoutId = setTimeout(() => finish([]), RECENT_TIMEOUT_MS);

    let response: Promise<unknown>;
    try {
      response = chrome.tabs.sendMessage(tabId, {
        type: "get-recent-translations",
      } satisfies RecentTranslationsMessage);
    } catch {
      finish([]);
      return;
    }

    Promise.resolve(response).then(
      (value) => finish(extractRecentParagraphs(value)),
      () => finish([]),
    );
  });
}

function extractRecentParagraphs(value: unknown): RecentParagraph[] {
  if (!value || typeof value !== "object") return [];
  const paragraphs = (value as { paragraphs?: unknown }).paragraphs;
  if (!Array.isArray(paragraphs) || !paragraphs.every(isRecentParagraph)) return [];
  return paragraphs;
}

function isRecentParagraph(value: unknown): value is RecentParagraph {
  if (!value || typeof value !== "object") return false;
  const paragraph = value as { source?: unknown; translation?: unknown };
  return typeof paragraph.source === "string" && typeof paragraph.translation === "string";
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
  if (!session || streaming || !lastRequest) return;
  const request = lastRequest;

  // Drop the failed/partial assistant turn and keep the original user turn
  // exactly once. `sendRequest` then sends history without an empty assistant
  // placeholder and appends a fresh one for the new stream.
  const messages = session.messages.slice();
  while (messages.length > 0 && messages.at(-1)!.role === "assistant") messages.pop();
  if (!messages.some((message) => message.role === "user")) {
    messages.push({ role: "user", content: request.text, quote: request.quote, ts: Date.now() });
  }
  session = { ...session, messages };
  renderAll();
  persistHistory();

  void sendRequest({ text: request.text, quote: request.quote, appendUser: false });
}

function setInputEnabled(enabled: boolean): void {
  input.disabled = !enabled;
  sendBtn.hidden = !enabled;
  stopBtn.hidden = enabled;
  updateBanner();
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
  // The provider's raw message is English and can leak internals; show only
  // the normalized Chinese copy (the dispatch layer already logs failures).
  showError(CHINESE_ERRORS[message.code] ?? CHINESE_ERRORS.unknown, "重新发送");
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
