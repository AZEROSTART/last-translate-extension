/**
 * Content-script orchestration: activate → detect → queue → batch-translate →
 * render → restore. Owns the paragraph registry, the translate port, the
 * dynamic-content observer and the SPA-rescan hook. Paragraph detection,
 * rendering and port mechanics stay in their own modules; this file only wires
 * them together.
 *
 * The translate port is resolved lazily on the first `send` (not in
 * `runContentMain`), so tests can install `globalThis.__ilmtTestPort` after
 * startup. One translate request is in flight at a time per page.
 */

import { collectParagraphs, type ParagraphNode } from "./paragraphs";
import { renderTranslation, restoreAll } from "./render";
import { ParagraphRegistry, type ParagraphRecord } from "./registry";
import { createTranslatePort, type PortError, type TranslatePortClient } from "./port";
import { initSelectionBubble, showSelectionBubble } from "./selection";
import type {
  BackgroundToClient,
  ClientToBackground,
  RecentTranslationsResponse,
} from "../shared/types";

/** Per-page paragraph ceiling (spec §13); beyond this we translate the first N only. */
const MAX_PARAGRAPHS = 2000;
/** Dynamic-content enqueue ceiling per rolling minute (spec §8.4). */
const MAX_DYNAMIC_PER_MINUTE = 200;
/** Paragraphs sent per `translate` request (spec §8.5). */
const BATCH_SIZE = 20;
/** MutationObserver debounce (spec §8.4). */
const MUTATION_DEBOUNCE_MS = 250;
/** Viewport-first band below the fold (spec §8.5 `rootMargin: 300px`). */
const VIEWPORT_MARGIN_PX = 300;
/** Scroll-triggered pump debounce, matching the mutation debounce. */
const SCROLL_DEBOUNCE_MS = 250;
/** Registry prune cadence (spec §8.4). */
const PRUNE_INTERVAL_MS = 30_000;
const DEFAULT_TARGET_LANG = "zh-CN";
const DYNAMIC_WINDOW_MS = 60_000;
/** Delay before an automatic retry after the provider rate-limited us. */
const RATE_LIMIT_RETRY_MS = 3000;
/** Recent translations exposed to the side panel. */
const RECENT_TRANSLATIONS_LIMIT = 5;
/** Bound on the per-text language-detection cache. */
const LANG_CACHE_LIMIT = 500;
/** Exact background message that means "no provider is configured". */
const NO_PROVIDER_MESSAGE = "未选择模型配置";

interface IlmtMain {
  translatePage(): Promise<void>;
  restore(): void;
  isActive(): boolean;
  askSelection(): void;
  showSelectionBubble(): void;
}

type TestPort = { send(message: ClientToBackground): void };

const scope = globalThis as typeof globalThis & {
  __ilmtMain?: IlmtMain;
  __ilmtTestPort?: TestPort;
};

let started = false;
let active = false;
let targetLang = DEFAULT_TARGET_LANG;
let registry = new ParagraphRegistry();
let portClient: TranslatePortClient | null = null;
let currentRequestId: string | null = null;
/** Lets a late `result` for a request that errored first still render. */
let lastCompletedRequestId: string | null = null;
let requestIdCounter = 0;

let observer: MutationObserver | null = null;
let observerPaused = false;
let mutationTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let scrollListening = false;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
/** While set, `pump` waits for the single rate-limit retry timer. */
let rateLimitHold = false;

let activeBanner: HTMLElement | null = null;
let errorBanner: HTMLElement | null = null;

/** Latest streamed text per paragraph; deltas append rather than replace. */
const deltaBuffers = new Map<string, string>();
/** `chrome.i18n.detectLanguage` results, bounded to one page's paragraphs. */
const langCache = new Map<string, string | null>();

let dynamicCount = 0;
let dynamicWindowStart = 0;

export function runContentMain(): void {
  if (started) return;
  started = true;

  // Bubbles and translation nodes are styled by `inject.css` from the manifest
  // content_scripts CSS entry, which page CSP cannot block (Ruling 20).
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  scope.__ilmtMain = { translatePage, restore, isActive, askSelection, showSelectionBubble };

  initSelectionBubble({
    onExplain: (text) => sendOpenChat(text, "explain"),
    onFollowUp: (text) => sendOpenChat(text, "follow-up"),
  });
}

async function translatePage(): Promise<void> {
  if (active) return;
  active = true;
  showActiveBanner();

  startPruneTimer();
  startObserver();
  startScrollListener();

  await collectAndQueue();
}

async function rescan(): Promise<void> {
  registry = new ParagraphRegistry();
  // `restoreAll` removes both injected translation spans and `data-ilmt-p`
  // marks. Without it a surviving SPA paragraph would keep its previous
  // translation, and `collectParagraphs` would read `textContent` polluted by
  // it — producing a translation-of-translation.
  restoreAll(document.body);
  await collectAndQueue();
}

/** Collect the full page, cap at MAX_PARAGRAPHS, queue and start the first batch. */
async function collectAndQueue(): Promise<void> {
  targetLang = await readTargetLang();
  const nodes = await collectParagraphs(document.body, {
    targetLang,
    detectLang: detectLang,
  });

  const overflow = nodes.slice(MAX_PARAGRAPHS);
  for (const node of overflow) node.el.removeAttribute("data-ilmt-p");
  if (overflow.length > 0) {
    console.warn(
      `[ilmt] page exceeds ${MAX_PARAGRAPHS} paragraphs; translating the first ${MAX_PARAGRAPHS} only`,
    );
  }

  queueNodes(nodes.slice(0, MAX_PARAGRAPHS));
}

function queueNodes(nodes: ParagraphNode[]): void {
  for (const node of nodes) {
    registry.add(node);
    registry.setStatus(node.id, "queued");
  }
  pump();
}

/**
 * Take the next queued batch in viewport-first order and send one `translate`
 * request, if any. Ordering follows spec §8.5: paragraphs inside the viewport
 * first, then the band just below it (≤300px), then everything else by
 * increasing distance; detached elements go last.
 */
function pump(): void {
  // Single-flight: a mutation/rescan during streaming must not overwrite the
  // in-flight request and strand its records.
  if (!active || currentRequestId !== null || rateLimitHold) return;
  registry.prune();
  const batch = takeNearestQueued(BATCH_SIZE);
  if (batch.length === 0) {
    currentRequestId = null;
    return;
  }

  const requestId = newRequestId();
  currentRequestId = requestId;
  const items = batch.map((rec) => ({
    id: rec.id,
    text: rec.sourceText,
    hash: hashText(rec.sourceText),
  }));
  send({ type: "translate", requestId, tabId: 0, items });
}

/**
 * Select `limit` queued records nearest the viewport and mark them `inflight`.
 * `ParagraphRegistry.takeQueued` stays FIFO; ordering is a selection concern
 * owned here. Insertion order breaks ties so the result is deterministic.
 */
function takeNearestQueued(limit: number): ParagraphRecord[] {
  const ranked = registry
    .all()
    .filter((record) => record.status === "queued")
    .map((record, index) => ({ record, index, rank: viewportRank(record) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);

  const batch = ranked.slice(0, limit).map((entry) => entry.record);
  for (const record of batch) registry.setStatus(record.id, "inflight");
  return batch;
}

/**
 * Distance order for a record: 0 inside the viewport, 1..300 in the band just
 * below it, then `300 + absolute distance` for the rest and `Infinity` for
 * detached elements (which sort last).
 */
function viewportRank(record: ParagraphRecord): number {
  const el = record.el.deref();
  if (!el || !el.isConnected) return Number.POSITIVE_INFINITY;

  const rect = el.getBoundingClientRect();
  const viewHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  if (rect.bottom >= 0 && rect.top <= viewHeight) return 0;
  if (rect.top > viewHeight) {
    const below = rect.top - viewHeight;
    return below <= VIEWPORT_MARGIN_PX ? below : VIEWPORT_MARGIN_PX + below;
  }
  // Above the viewport: not the "just below" band, so it ranks after it.
  return VIEWPORT_MARGIN_PX + Math.abs(rect.bottom);
}

function restore(): void {
  active = false;

  if (currentRequestId) {
    send({ type: "abort", requestId: currentRequestId });
    currentRequestId = null;
  }
  lastCompletedRequestId = null;

  restoreAll(document.body);
  registry = new ParagraphRegistry();
  deltaBuffers.clear();
  langCache.clear();
  stopObserver();
  stopPruneTimer();
  stopScrollListener();
  removeActiveBanner();
  removeErrorBanner();
  clearRateLimitTimer();
  // A fresh activation gets a clean observer and dynamic rate budget.
  observerPaused = false;
  dynamicCount = 0;
  dynamicWindowStart = 0;

  // Content-side cleanup is synchronous, but the port must stay open long
  // enough for the `abort` post to reach the background: Chrome gives no
  // ordering guarantee between `postMessage` and `disconnect`. One macrotask
  // is enough, and the captured client keeps a rapid re-activation from being
  // closed by the previous teardown.
  const client = portClient;
  portClient = null;
  if (client) {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      client.close();
    }, 0);
  }
}

function isActive(): boolean {
  return active;
}

function send(message: ClientToBackground): void {
  const hook = scope.__ilmtTestPort;
  if (hook) {
    hook.send(message);
    return;
  }

  if (!portClient) {
    portClient = createTranslatePort({
      onDelta: handleDelta,
      onResult: handleResult,
      onError: handleError,
      onFinish: handleFinish,
      onDisconnect: handleDisconnect,
    });
  }
  portClient.send(message);
}

/**
 * Ask the background to open the side panel for a selection. Task 14 adds the
 * `open-chat` handler; until then — and in unit tests — there may be no
 * receiver, so a rejected send is deliberately ignored.
 */
function sendOpenChat(text: string, mode: "explain" | "follow-up"): void {
  try {
    const pending = chrome.runtime.sendMessage({ type: "open-chat", text, mode });
    void Promise.resolve(pending).catch(() => {});
  } catch {
    // No `sendMessage` in the test mock / no listener registered yet.
  }
}

function handleDelta(msg: Extract<BackgroundToClient, { type: "delta" }>): void {
  if (msg.requestId !== currentRequestId) return;
  const el = registry.get(msg.id)?.el.deref();
  if (!el) return;
  // Providers stream chunks, not snapshots: append so the rendered text grows.
  const buffered = (deltaBuffers.get(msg.id) ?? "") + msg.text;
  deltaBuffers.set(msg.id, buffered);
  renderTranslation(el, msg.id, buffered, targetLang);
}

function handleResult(msg: Extract<BackgroundToClient, { type: "result" }>): void {
  const isCurrent = msg.requestId === currentRequestId;
  if (!isCurrent && msg.requestId !== lastCompletedRequestId) return;
  for (const item of msg.items) {
    const rec = registry.get(item.id);
    if (!rec) continue;
    const el = rec.el.deref();
    if (el) renderTranslation(el, item.id, item.text, targetLang);
    registry.setStatus(item.id, "done");
    registry.setTranslation(item.id, item.text);
    deltaBuffers.delete(item.id);
  }
  if (isCurrent) completeRequest(msg.requestId);
}

function handleError(msg: PortError): void {
  if (msg.type === "connection-error") {
    // Transport died: requeue and resume. The port client queues the send and
    // reconnects, so a fresh `translate` is not lost.
    registry.requeueInflight();
    deltaBuffers.clear();
    currentRequestId = null;
    lastCompletedRequestId = null;
    pump();
    return;
  }
  if (msg.requestId !== currentRequestId) return;

  if (msg.code === "rate_limit") {
    // Retryable at the request level: keep the source text, put the ids back,
    // show the banner and let a single delayed pump retry when idle.
    for (const id of msg.ids) {
      registry.setStatus(id, "queued");
      deltaBuffers.delete(id);
    }
    showErrorBanner(msg.code, msg.message);
    scheduleRateLimitRetry();
    completeRequest(msg.requestId);
    return;
  }

  for (const id of msg.ids) {
    registry.setStatus(id, "failed");
    deltaBuffers.delete(id);
  }
  if (msg.code !== "aborted") showErrorBanner(msg.code, msg.message);
  completeRequest(msg.requestId);
}

/** The current request ended: clear it and start the next batch exactly once. */
function completeRequest(requestId: string): void {
  if (requestId !== currentRequestId) return;
  currentRequestId = null;
  lastCompletedRequestId = requestId;
  deltaBuffers.clear();
  if (!rateLimitHold) pump();
}

function handleFinish(msg: Extract<BackgroundToClient, { type: "finish" }>): void {
  completeRequest(msg.requestId);
}

function handleDisconnect(): void {
  registry.requeueInflight();
  deltaBuffers.clear();
  currentRequestId = null;
  lastCompletedRequestId = null;
  pump();
}

function handleRuntimeMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse?: (response: unknown) => void,
): void {
  if (!message || typeof message !== "object") return;
  const type = (message as { type?: unknown }).type;
  if (
    type !== "page-navigated" &&
    type !== "activate" &&
    type !== "ask-selection" &&
    type !== "get-recent-translations"
  ) {
    return;
  }
  if (sender?.id !== chrome.runtime.id) return;

  if (type === "page-navigated") {
    if (active) void rescan();
    return;
  }

  if (type === "get-recent-translations") {
    sendResponse?.({ paragraphs: recentTranslations() });
    return;
  }

  // `activate` is the Alt+A toggle. The first press is replayed by the guard;
  // every later press reaches this listener and toggles translation.
  if (type === "activate") {
    if (isActive()) restore();
    else void translatePage();
    return;
  }

  // Alt+Q: explain the current selection in the side panel (spec §8.9).
  askSelection();
}

/** Last finished source/translation pairs, newest at the end, capped at 5. */
function recentTranslations(): RecentTranslationsResponse["paragraphs"] {
  return registry
    .all()
    .filter(
      (record) =>
        record.status === "done" &&
        typeof record.translation === "string" &&
        record.translation.length > 0,
    )
    .slice(-RECENT_TRANSLATIONS_LIMIT)
    .map((record) => ({ source: record.sourceText, translation: record.translation! }));
}

/**
 * Explain the current selection in the side panel. Exposed on `__ilmtMain` so
 * the guard can dispatch an ask-selection that arrived before this bundle
 * loaded.
 */
function askSelection(): void {
  const text = window.getSelection()?.toString().trim() ?? "";
  if (text.length >= 2) sendOpenChat(text, "explain");
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible" && active) {
    send({ type: "ping" });
  }
}

function startObserver(): void {
  if (observer || observerPaused) return;
  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  if (mutationTimer !== null) {
    clearTimeout(mutationTimer);
    mutationTimer = null;
  }
}

function startScrollListener(): void {
  if (scrollListening) return;
  window.addEventListener("scroll", handleScroll, { passive: true });
  scrollListening = true;
}

function stopScrollListener(): void {
  if (scrollListening) {
    window.removeEventListener("scroll", handleScroll);
    scrollListening = false;
  }
  if (scrollTimer !== null) {
    clearTimeout(scrollTimer);
    scrollTimer = null;
  }
}

/**
 * Scrolling near/into already-collected content is an additional pump trigger
 * (continuous `finish` batching stays the primary one). It never preempts an
 * in-flight request; the queued records are simply left for the next pump.
 */
function handleScroll(): void {
  if (!active) return;
  if (scrollTimer !== null) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    if (active && currentRequestId === null) pump();
  }, SCROLL_DEBOUNCE_MS);
}

function handleMutations(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    if (mutation.type !== "characterData") continue;
    const target = mutation.target;
    const el = target instanceof Element ? target : target.parentElement;
    if (el?.closest(".ilmt-tr")) continue;
    const marked = el?.closest("[data-ilmt-p]");
    if (marked) invalidateParagraph(marked);
  }

  const relevant = mutations.some((mutation) => {
    const target = mutation.target;
    const el = target instanceof Element ? target : target.parentElement;
    return !(el && el.closest(".ilmt-tr"));
  });
  if (!relevant) return;
  if (mutationTimer !== null) return;
  mutationTimer = setTimeout(() => {
    mutationTimer = null;
    void enqueueNewParagraphs();
  }, MUTATION_DEBOUNCE_MS);
}

/**
 * An edited source paragraph is stale: drop its translation and marker and let
 * the next scan re-collect it under a fresh id.
 */
function invalidateParagraph(el: Element): void {
  const id = el.getAttribute("data-ilmt-p");
  if (!id) return;
  el.ownerDocument.querySelector(`[data-ilmt-for="${id}"]`)?.remove();
  el.removeAttribute("data-ilmt-p");
  registry.remove(id);
  deltaBuffers.delete(id);
}

async function enqueueNewParagraphs(): Promise<void> {
  if (!active || observerPaused) return;
  const nodes = await collectParagraphs(document.body, {
    targetLang,
    detectLang: detectLang,
  });
  if (nodes.length === 0) return;

  if (!reserveDynamicSlots(nodes.length)) {
    for (const node of nodes) node.el.removeAttribute("data-ilmt-p");
    pauseObservation();
    return;
  }
  queueNodes(nodes);
}

function reserveDynamicSlots(count: number): boolean {
  const now = Date.now();
  if (now - dynamicWindowStart >= DYNAMIC_WINDOW_MS) {
    dynamicWindowStart = now;
    dynamicCount = 0;
  }
  if (dynamicCount + count > MAX_DYNAMIC_PER_MINUTE) return false;
  dynamicCount += count;
  return true;
}

function pauseObservation(): void {
  observerPaused = true;
  stopObserver();
  console.warn(
    `[ilmt] new-paragraph rate exceeded ${MAX_DYNAMIC_PER_MINUTE}/min; observation paused`,
  );
}

function startPruneTimer(): void {
  if (pruneTimer !== null) return;
  pruneTimer = setInterval(() => registry.prune(), PRUNE_INTERVAL_MS);
}

function stopPruneTimer(): void {
  if (pruneTimer !== null) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

interface ErrorPresentation {
  text: string;
  settings: boolean;
  retry: boolean;
}

/** Map a background error code/message to the Chinese banner copy (spec §11). */
function describeError(code: string, message: string): ErrorPresentation {
  switch (code) {
    case "auth":
      return { text: "API key 无效或权限不足", settings: true, retry: false };
    case "rate_limit":
      return { text: "请求过于频繁，稍后自动重试", settings: false, retry: true };
    case "timeout":
    case "network":
    case "unknown":
      return { text: "翻译失败，可重试", settings: false, retry: true };
    case "bad_response":
      return message === NO_PROVIDER_MESSAGE || message.includes("未选择模型配置")
        ? { text: "尚未配置模型", settings: true, retry: false }
        : { text: "模型返回格式不符", settings: false, retry: true };
    default:
      return { text: "翻译失败，可重试", settings: false, retry: true };
  }
}

function showActiveBanner(): void {
  if (activeBanner) return;
  const el = document.createElement("div");
  el.className = "ilmt-active-banner";
  el.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "ilmt-active-text";
  text.textContent = "翻译已开启";

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.className = "ilmt-restore";
  restoreButton.textContent = "还原";
  restoreButton.addEventListener("click", () => restore());

  el.append(text, restoreButton);
  (document.body ?? document.documentElement).appendChild(el);
  activeBanner = el;
}

function removeActiveBanner(): void {
  activeBanner?.remove();
  activeBanner = null;
}

/** One error banner at a time, never auto-closed, with an explicit `×`. */
function showErrorBanner(code: string, message: string): void {
  const presentation = describeError(code, message);
  removeErrorBanner();

  const el = document.createElement("div");
  el.className = "ilmt-error-banner";
  el.setAttribute("role", "alert");

  const text = document.createElement("span");
  text.className = "ilmt-error-message";
  text.textContent = presentation.text;
  el.appendChild(text);

  if (presentation.retry) {
    el.appendChild(
      bannerButton("重试", "ilmt-error-retry", () => {
        retryFailedRequests();
      }),
    );
  }
  if (presentation.settings) {
    el.appendChild(
      bannerButton("设置", "ilmt-error-options", () => {
        sendOpenOptions();
      }),
    );
  }
  el.appendChild(
    bannerButton("×", "ilmt-error-close", () => {
      removeErrorBanner();
    }, "关闭"),
  );

  (document.body ?? document.documentElement).appendChild(el);
  errorBanner = el;
}

function bannerButton(
  label: string,
  className: string,
  onClick: () => void,
  ariaLabel?: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", onClick);
  return button;
}

function removeErrorBanner(): void {
  errorBanner?.remove();
  errorBanner = null;
}

/** User asked to retry: requeue every failed paragraph and pump if idle. */
function retryFailedRequests(): void {
  removeErrorBanner();
  clearRateLimitTimer();
  for (const record of registry.all()) {
    if (record.status === "failed") registry.setStatus(record.id, "queued");
  }
  pump();
}

function sendOpenOptions(): void {
  try {
    const pending = chrome.runtime.sendMessage({ type: "open-options" });
    void Promise.resolve(pending).catch(() => {});
  } catch {
    // No receiver in the test mock; the click is still a no-op, not an error.
  }
}

function scheduleRateLimitRetry(): void {
  rateLimitHold = true;
  if (rateLimitTimer !== null) return;
  rateLimitTimer = setTimeout(() => {
    rateLimitTimer = null;
    rateLimitHold = false;
    pump();
  }, RATE_LIMIT_RETRY_MS);
}

function clearRateLimitTimer(): void {
  rateLimitHold = false;
  if (rateLimitTimer !== null) {
    clearTimeout(rateLimitTimer);
    rateLimitTimer = null;
  }
}

async function readTargetLang(): Promise<string> {
  try {
    const stored = (await chrome.storage.local.get("settings")) as {
      settings?: { targetLang?: unknown };
    };
    const value = stored?.settings?.targetLang;
    if (typeof value === "string" && value.length > 0) return value;
  } catch {
    // Missing or unreadable storage: fall through to the default.
  }
  return DEFAULT_TARGET_LANG;
}

/**
 * `chrome.i18n.detectLanguage` wrapper. Chrome has shipped both the callback
 * and the promise shape; accept either. Failures degrade to `null`, which
 * makes `collectParagraphs` use its CJK heuristic.
 */
async function detectLang(text: string): Promise<string | null> {
  if (langCache.has(text)) return langCache.get(text) ?? null;
  const detected = await detectLanguage(text);
  if (langCache.size >= LANG_CACHE_LIMIT) langCache.clear();
  langCache.set(text, detected);
  return detected;
}

function detectLanguage(text: string): Promise<string | null> {
  const api = (chrome.i18n as typeof chrome.i18n | undefined)?.detectLanguage as
    | ((text: string, callback: (result: unknown) => void) => unknown)
    | undefined;
  if (typeof api !== "function") return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(topLanguage(result));
    };
    try {
      const maybe = api(text, finish);
      if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
        (maybe as Promise<unknown>).then(finish, () => finish(null));
      }
    } catch {
      finish(null);
    }
  });
}

function topLanguage(result: unknown): string | null {
  const languages = (result as { languages?: Array<{ language?: unknown; percentage?: unknown }> })
    ?.languages;
  if (!Array.isArray(languages) || languages.length === 0) return null;

  let best = languages[0];
  for (const candidate of languages) {
    if (Number(candidate.percentage) > Number(best.percentage)) best = candidate;
  }
  return typeof best.language === "string" && best.language.length > 0 ? best.language : null;
}

function newRequestId(): string {
  return `r_${++requestIdCounter}`;
}

/** djb2 (xor variant) as a 32-bit hex string; the protocol requires a string hash. */
function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
