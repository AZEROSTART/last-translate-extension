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

import { collectParagraphs, clearMarks, type ParagraphNode } from "./paragraphs";
import { renderTranslation, restoreAll } from "./render";
import { ParagraphRegistry } from "./registry";
import { createTranslatePort, type PortError, type TranslatePortClient } from "./port";
import type { BackgroundToClient, ClientToBackground } from "../shared/types";
import cssText from "../styles/inject.css?inline";

/** Per-page paragraph ceiling (spec §13); beyond this we translate the first N only. */
const MAX_PARAGRAPHS = 2000;
/** Dynamic-content enqueue ceiling per rolling minute (spec §8.4). */
const MAX_DYNAMIC_PER_MINUTE = 200;
/** Paragraphs sent per `translate` request (spec §8.5). */
const BATCH_SIZE = 20;
/** MutationObserver debounce (spec §8.4). */
const MUTATION_DEBOUNCE_MS = 250;
/** Registry prune cadence (spec §8.4). */
const PRUNE_INTERVAL_MS = 30_000;
const DEFAULT_TARGET_LANG = "zh-CN";
const DYNAMIC_WINDOW_MS = 60_000;

interface IlmtMain {
  translatePage(): Promise<void>;
  restore(): void;
  isActive(): boolean;
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

let dynamicCount = 0;
let dynamicWindowStart = 0;

export function runContentMain(): void {
  if (started) return;
  started = true;

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  scope.__ilmtMain = { translatePage, restore, isActive };
}

async function translatePage(): Promise<void> {
  if (active) return;
  active = true;

  injectStyles();
  startPruneTimer();
  startObserver();

  await collectAndQueue();
}

async function rescan(): Promise<void> {
  registry = new ParagraphRegistry();
  clearMarks(document.body);
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

/** Take the next queued batch and send one `translate` request, if any. */
function pump(): void {
  if (!active) return;
  registry.prune();
  const batch = registry.takeQueued(BATCH_SIZE);
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
  // A fresh activation gets a clean observer and dynamic rate budget.
  observerPaused = false;
  dynamicCount = 0;
  dynamicWindowStart = 0;
  portClient?.close();
  portClient = null;
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
  if ((message as { type?: string }).type !== "page-navigated") return;
  if (sender?.id !== chrome.runtime.id) return;
  if (!active) return;
  void rescan();
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

function injectStyles(): void {
  if (document.querySelector("style[data-ilmt]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-ilmt", "");
  style.textContent = cssText;
  (document.head ?? document.documentElement).appendChild(style);
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
