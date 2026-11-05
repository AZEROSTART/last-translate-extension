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
import { initSelectionBubble } from "./selection";
import type { BackgroundToClient, ClientToBackground } from "../shared/types";

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

interface IlmtMain {
  translatePage(): Promise<void>;
  restore(): void;
  isActive(): boolean;
  askSelection(): void;
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
let requestIdCounter = 0;

let observer: MutationObserver | null = null;
let observerPaused = false;
let mutationTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let scrollListening = false;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

let dynamicCount = 0;
let dynamicWindowStart = 0;

export function runContentMain(): void {
  if (started) return;
  started = true;

  // Bubbles and translation nodes are styled by `inject.css` from the manifest
  // content_scripts CSS entry, which page CSP cannot block (Ruling 20).
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  scope.__ilmtMain = { translatePage, restore, isActive, askSelection };

  initSelectionBubble({
    onExplain: (text) => sendOpenChat(text, "explain"),
    onFollowUp: (text) => sendOpenChat(text, "follow-up"),
  });
}

async function translatePage(): Promise<void> {
  if (active) return;
  active = true;

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
  const nodes = await collectParagraphs(document.body, { targetLang });

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
  if (!active) return;
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

  restoreAll(document.body);
  registry = new ParagraphRegistry();
  stopObserver();
  stopPruneTimer();
  stopScrollListener();
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
  if (el) renderTranslation(el, msg.id, msg.text, targetLang);
}

function handleResult(msg: Extract<BackgroundToClient, { type: "result" }>): void {
  if (msg.requestId !== currentRequestId) return;
  for (const item of msg.items) {
    const rec = registry.get(item.id);
    if (!rec) continue;
    const el = rec.el.deref();
    if (el) renderTranslation(el, item.id, item.text, targetLang);
    registry.setStatus(item.id, "done");
    registry.setTranslation(item.id, item.text);
  }
}

function handleError(msg: PortError): void {
  if (msg.type === "connection-error") {
    registry.requeueInflight();
    currentRequestId = null;
    return;
  }
  if (msg.requestId !== currentRequestId) return;
  for (const id of msg.ids) registry.setStatus(id, "failed");
}

function handleFinish(msg: Extract<BackgroundToClient, { type: "finish" }>): void {
  if (msg.requestId !== currentRequestId) return;
  pump();
}

function handleDisconnect(): void {
  registry.requeueInflight();
  currentRequestId = null;
}

function handleRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender): void {
  if (!message || typeof message !== "object") return;
  const type = (message as { type?: unknown }).type;
  if (type !== "page-navigated" && type !== "activate" && type !== "ask-selection") return;
  if (sender?.id !== chrome.runtime.id) return;

  if (type === "page-navigated") {
    if (active) void rescan();
    return;
  }

  // `activate` is produced by the background command wiring. The first one is
  // consumed by the guard (which loads this bundle); subsequent presses reach
  // this listener and start translation.
  if (type === "activate") {
    void translatePage();
    return;
  }

  // Alt+Q: explain the current selection in the side panel (spec §8.9).
  askSelection();
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

async function enqueueNewParagraphs(): Promise<void> {
  if (!active || observerPaused) return;
  const nodes = await collectParagraphs(document.body, { targetLang });
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
