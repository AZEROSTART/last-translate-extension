/**
 * Content-script orchestration: activate → detect → observe/queue →
 * batch-translate → render → restore. Owns the paragraph registry, the
 * translate port, the visibility observer, the dynamic-content observer and
 * the SPA-rescan hook. Paragraph detection,
 * rendering and port mechanics stay in their own modules; this file only wires
 * them together.
 *
 * The translate port is resolved lazily on the first `send` (not in
 * `runContentMain`), so tests can install `globalThis.__ilmtTestPort` after
 * startup. One translate request is in flight at a time per page.
 */

import {
  collectParagraphs,
  forgetPiece,
  forgetPiecesInRoot,
  pieceRootFor,
  resetPieceCache,
  unmarkPiece,
  type LanguageDetection,
  type ParagraphNode,
} from "./paragraphs";
import { getSiteRule } from "./site-rules";
import {
  clearInlineLoader,
  discardLoading,
  renderLoading,
  renderTranslation,
  restoreAll,
} from "./render";
import { ParagraphRegistry, type ParagraphRecord } from "./registry";
import { createTranslatePort, type PortError, type TranslatePortClient } from "./port";
import { createVisibilityObserver, inPrefetchBand, type VisibilityObserver } from "./visibility";
import { createGlossController } from "./glossary";
import { initSelectionBubble, showSelectionBubble } from "./selection";
import { buildSelectionContext } from "./selection-context";
import { DEFAULT_SETTINGS, getSettings } from "../shared/storage";
import type {
  BackgroundToClient,
  ClientToBackground,
  EffectSettings,
  GlossaryNote,
  OpenChatMessage,
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
/** Viewport heights below the fold that are queued before they are seen. */
const VIEWPORT_PREFETCH_SCREENS = 1;
/** Coalescing window for roots that enter the visible band together. */
const VISIBILITY_BATCH_MS = 150;
/** Registry prune cadence (spec §8.4). */
const PRUNE_INTERVAL_MS = 30_000;
const DEFAULT_TARGET_LANG = "zh-CN";
const DYNAMIC_WINDOW_MS = 60_000;
/** Base delay before an automatic retry after the provider rate-limited us. */
const RATE_LIMIT_RETRY_MS = 3000;
/** Automatic rate-limit retries per request before the user must retry. */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Upper bound for the exponential rate-limit backoff. */
const RATE_LIMIT_RETRY_MAX_MS = 30_000;
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
let minParagraphLength = DEFAULT_SETTINGS.minParagraphLength;
let contentOnly = DEFAULT_SETTINGS.contentOnly;
let learningLangs: string[] = [...DEFAULT_SETTINGS.learningLangs];
let effectSettings: EffectSettings = DEFAULT_SETTINGS.mascot;
let registry = new ParagraphRegistry();
const gloss = createGlossController(document, {
  getEffectSettings: () => effectSettings,
  getGlossLang: () => targetLang,
});
let portClient: TranslatePortClient | null = null;
let currentRequestId: string | null = null;
/** Lets a late `result` for a request that errored first still render. */
let lastCompletedRequestId: string | null = null;
let requestIdCounter = 0;

let observer: MutationObserver | null = null;
let observerPaused = false;
let mutationTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
/** Grants queue rights to paragraphs that scroll into the visible band. */
let visibility: VisibilityObserver | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
/** While set, `pump` waits for the single rate-limit retry timer. */
let rateLimitHold = false;
/** Automatic retries spent since the last successful/manual request. */
let rateLimitAttempts = 0;
/** The requestId already counted for a 429 (several groups may report one). */
let rateLimitAttemptedRequestId: string | null = null;
/** Request whose automatic retry budget is exhausted. */
let rateLimitExhaustedRequestId: string | null = null;

/** Scan coordinator: one scan at a time; a newer one is queued behind it. */
type ScanKind = "full" | "dynamic";
interface ScanTicket {
  kind: ScanKind;
  generation: number;
}
/** Invalidates async scans captured before restore/rescan/activation. */
let scanGeneration = 0;
let scanInFlight: Promise<void> | null = null;
let pendingScan: ScanTicket | null = null;

let activeBanner: HTMLElement | null = null;
let errorBanner: HTMLElement | null = null;

/** Latest streamed text per paragraph; deltas append rather than replace. */
const deltaBuffers = new Map<string, string>();
/** `chrome.i18n.detectLanguage` results, bounded to one page's paragraphs. */
const langCache = new Map<string, LanguageDetection | null>();

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
    onExplain: (text, range) => sendOpenChat(text, "explain", range),
    onFollowUp: (text, range) => sendOpenChat(text, "follow-up", range),
  });
}

async function translatePage(): Promise<void> {
  if (active) return;
  active = true;
  scanGeneration += 1;

  try {
    gloss.start();
    showActiveBanner();
    startPruneTimer();
    startVisibilityObserver();

    // At document_start `<body>` may not exist yet; wait for the parser before
    // touching the tree. A rescan may have bumped the generation while we
    // waited, so scan under the CURRENT generation instead of returning: the
    // earlier rescan could not see a body and therefore queued nothing.
    await whenBodyReady();
    if (!active) return;
    startObserver();

    await requestScan("full", scanGeneration);
  } catch (error) {
    reportScanError(error);
  }
}

async function rescan(): Promise<void> {
  if (!active) return;
  // A SPA route change can arrive before `<body>` exists. Bumping the
  // generation then would strand the activation's pending scan; wait instead.
  await whenBodyReady();
  if (!active) return;
  // Invalidate the previous scan first, then rebuild marks and run a fresh
  // full scan; the coordinator queues it behind any still-running scan.
  const generation = ++scanGeneration;
  stopVisibilityObserver();
  registry = new ParagraphRegistry();
  gloss.clear();
  // `restoreAll` removes both injected translation spans and `data-ilmt-p`
  // marks. Without it a surviving SPA paragraph would keep its previous
  // translation, and `collectParagraphs` would read `textContent` polluted by
  // it — producing a translation-of-translation.
  if (document.body) restoreAll(document.body);
  resetPieceCache();
  await requestScan("full", generation);
}

/**
 * Resolve once `<body>` exists; content scripts can start before it does and
 * `readyState === "complete"` does not imply a body (e.g. XML documents).
 */
function whenBodyReady(): Promise<void> {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const root = document.documentElement;
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(root, { childList: true, subtree: true });
  });
}

/**
 * Queue a scan. Only one runs at a time; a request during a scan merges into a
 * single follow-up, and a full scan always dominates a dynamic one.
 */
function requestScan(kind: ScanKind, generation: number): Promise<void> {
  if (scanInFlight) {
    const queued = pendingScan;
    pendingScan = {
      kind: queued?.kind === "full" || kind === "full" ? "full" : "dynamic",
      generation: Math.max(queued?.generation ?? generation, generation),
    };
    return scanInFlight;
  }

  const run = runScanQueue({ kind, generation });
  scanInFlight = run;
  return run;
}

async function runScanQueue(first: ScanTicket): Promise<void> {
  let ticket: ScanTicket | null = first;
  try {
    while (ticket) {
      const current = ticket;
      ticket = null;
      try {
        if (current.kind === "full") await collectAndObserve(current.generation);
        else await enqueueNewParagraphs(current.generation);
      } catch (error) {
        reportScanError(error);
      }

      const queued = pendingScan;
      pendingScan = null;
      ticket = queued;
    }
  } finally {
    scanInFlight = null;
  }
}

/** Unexpected scan failures surface a banner instead of an unhandled rejection. */
function reportScanError(error: unknown): void {
  console.warn("[ilmt] page scan failed", error);
  if (active) showErrorBanner("unknown", "");
}

/** Remove marks added by a scan that was invalidated before it could queue. */
function unmarkNodes(nodes: ParagraphNode[]): void {
  for (const node of nodes) {
    unmarkPiece(node.el, node.id);
    forgetPiece(node.anchor);
  }
}

/** Collect the full page, cap at MAX_PARAGRAPHS, then observe or queue it. */
async function collectAndObserve(generation: number): Promise<void> {
  if (!active || generation !== scanGeneration) return;
  const body = document.body;
  if (!body) return;

  const prefs = await readCollectPrefs();
  if (!active || generation !== scanGeneration) return;
  targetLang = prefs.targetLang;
  minParagraphLength = prefs.minParagraphLength;
  contentOnly = prefs.contentOnly;
  learningLangs = prefs.learningLangs;
  effectSettings = prefs.mascot;

  const nodes = await collectParagraphs(body, {
    targetLang,
    minLength: minParagraphLength,
    contentOnly,
    detectLang: detectLang,
    url: document.location.href,
  });

  // A restore/rescan may have landed while detection was in flight: drop the
  // marks this scan added instead of resurrecting a cancelled page.
  if (!active || generation !== scanGeneration) {
    unmarkNodes(nodes);
    return;
  }

  const overflow = nodes.slice(MAX_PARAGRAPHS);
  for (const node of overflow) {
    unmarkPiece(node.el, node.id);
    forgetPiece(node.anchor);
  }
  if (overflow.length > 0) {
    console.warn(
      `[ilmt] page exceeds ${MAX_PARAGRAPHS} paragraphs; translating the first ${MAX_PARAGRAPHS} only`,
    );
  }

  registerScannedNodes(nodes.slice(0, MAX_PARAGRAPHS));
}

function startVisibilityObserver(): void {
  if (visibility) return;
  visibility = createVisibilityObserver({
    prefetchScreens: VIEWPORT_PREFETCH_SCREENS,
    batchMs: VISIBILITY_BATCH_MS,
    onVisible(ids) {
      if (!active) return;
      for (const id of ids) registry.setStatus(id, "queued");
      pump();
    },
  });
}

function stopVisibilityObserver(): void {
  visibility?.stop();
  visibility = null;
}

/**
 * Register a scanned batch and grant queue rights only to roots that are
 * already inside the viewport band. Everything else waits for the observer,
 * so scrolling (not the scan) decides when the rest is translated.
 */
function registerScannedNodes(nodes: ParagraphNode[]): void {
  for (const node of nodes) registry.add(node);
  if (nodes.length === 0) return;
  startVisibilityObserver();

  // One piece root can own several paragraph ids; observing it once reports
  // them together when it enters the band.
  const groups = new Map<Element, string[]>();
  for (const node of nodes) {
    const ids = groups.get(node.el);
    if (ids) ids.push(node.id);
    else groups.set(node.el, [node.id]);
  }

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  let queued = false;
  for (const [root, ids] of groups) {
    if (inPrefetchBand(root.getBoundingClientRect(), viewportHeight, VIEWPORT_PREFETCH_SCREENS)) {
      for (const id of ids) registry.setStatus(id, "queued");
      queued = true;
    } else {
      visibility!.observe(root, ids);
    }
  }
  if (queued) pump();
}

/**
 * Remove translation nodes whose paragraph record no longer exists. The
 * registry prunes records whose root or anchor was detached; the matching
 * `.ilmt-tr` node can survive that prune (e.g. after a text node is replaced
 * while its root stays), so this sweeps them up.
 */
function pruneOrphanTranslations(): void {
  const live = new Set(registry.all().map((record) => record.id));
  gloss.prune(live);
  for (const node of document.querySelectorAll(".ilmt-tr[data-ilmt-for]")) {
    const id = node.getAttribute("data-ilmt-for");
    if (!id || !live.has(id)) node.remove();
  }
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
  pruneOrphanTranslations();
  const batch = takeNearestQueued(BATCH_SIZE);
  if (batch.length === 0) {
    currentRequestId = null;
    return;
  }

  // Show the skeleton immediately for every piece in this batch. The guard is
  // defensive: `registry.prune()` above normally drops detached records first.
  for (const rec of batch) {
    const root = rec.el.deref();
    const anchor = rec.anchor.deref();
    if (!root || !anchor || !root.isConnected || !anchor.isConnected) continue;
    renderLoading({ root, anchor, heading: rec.heading }, rec.id, targetLang);
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
  // Invalidate any async scan and drop a queued follow-up: after restore a
  // cancelled scan must not mark or queue paragraphs.
  scanGeneration += 1;
  pendingScan = null;

  if (currentRequestId) {
    send({ type: "abort", requestId: currentRequestId });
    currentRequestId = null;
  }
  lastCompletedRequestId = null;

  gloss.stop();
  if (document.body) restoreAll(document.body);
  resetPieceCache();
  registry = new ParagraphRegistry();
  deltaBuffers.clear();
  langCache.clear();
  stopObserver();
  stopPruneTimer();
  stopVisibilityObserver();
  removeActiveBanner();
  removeErrorBanner();
  clearRateLimitTimer();
  resetRateLimitAttempts();
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
function sendOpenChat(
  text: string,
  mode: "explain" | "follow-up",
  range?: Range,
): void {
  let context: OpenChatMessage["context"];
  if (range) {
    try {
      context = buildSelectionContext(range);
    } catch {
      // Context extraction is best-effort; the quote itself must still send.
      context = undefined;
    }
  }

  try {
    const message: OpenChatMessage = {
      type: "open-chat",
      text,
      mode,
      ...(context ? { context } : {}),
    };
    const pending = chrome.runtime.sendMessage(message);
    void Promise.resolve(pending).catch(() => {});
  } catch {
    // No `sendMessage` in the test mock / no listener registered yet.
  }
}

function handleDelta(msg: Extract<BackgroundToClient, { type: "delta" }>): void {
  if (msg.requestId !== currentRequestId) return;
  const rec = registry.get(msg.id);
  const root = rec?.el.deref();
  const anchor = rec?.anchor.deref();
  if (!rec || !root || !anchor) return;
  // Providers stream chunks, not snapshots: append so the rendered text grows.
  const buffered = (deltaBuffers.get(msg.id) ?? "") + msg.text;
  deltaBuffers.set(msg.id, buffered);
  renderTranslation({ root, anchor, heading: rec.heading }, msg.id, buffered, targetLang);
}

/**
 * Annotate only paragraphs whose language is a learning target. Detection is
 * usually cached from collection, so this stays synchronous on the common path;
 * an uncached verdict upgrades or removes the card when it arrives.
 */
function registerGlossary(
  id: string,
  sourceText: string,
  textNodes: Node[],
  notes: GlossaryNote[],
): void {
  if (notes.length === 0) {
    gloss.removeParagraph(id);
    return;
  }

  const apply = (termLang: string | undefined): void => {
    if (termLang && !learningLangs.includes(termLang)) {
      gloss.removeParagraph(id);
      return;
    }
    gloss.setParagraph(id, textNodes, notes, termLang);
  };

  const cached = langCache.get(sourceText);
  const cachedPrefix = cached ? languagePrefix(cached.language) : undefined;
  apply(cachedPrefix);

  if (!cached) {
    void detectLang(sourceText).then((detected) => {
      if (!detected) return;
      const prefix = languagePrefix(detected.language);
      if (!learningLangs.includes(prefix)) gloss.removeParagraph(id);
      else gloss.setParagraph(id, textNodes, notes, prefix);
    });
  }
}

function handleResult(msg: Extract<BackgroundToClient, { type: "result" }>): void {  const isCurrent = msg.requestId === currentRequestId;
  if (!isCurrent && msg.requestId !== lastCompletedRequestId) return;
  for (const item of msg.items) {
    const rec = registry.get(item.id);
    if (!rec) continue;
    const root = rec.el.deref();
    const anchor = rec.anchor.deref();
    if (root && anchor) {
      renderTranslation({ root, anchor, heading: rec.heading }, item.id, item.text, targetLang);
    }
    const notes = item.glossary ?? [];
    const textNodes = rec.textNodes
      .map((ref) => ref.deref())
      .filter((node): node is Node => node !== undefined && node.isConnected);
    registerGlossary(item.id, rec.sourceText, textNodes, notes);
    registry.setGlossary(item.id, notes);
    registry.setStatus(item.id, "done");
    registry.setTranslation(item.id, item.text);
    deltaBuffers.delete(item.id);
    // `renderTranslation` already clears the marker; this also covers a record
    // whose root/anchor vanished between the skeleton and the result.
    clearInlineLoader(item.id);
  }
  updateActiveBannerHint();
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
    handleRateLimitError(msg);
    return;
  }

  // Handle EVERY group error for this request. Do not clear the request on
  // error: a later group's error must still be processed. The background's
  // `finish` clears the request and pumps once all groups have settled.
  failIds(msg.ids);
  if (msg.code !== "aborted") showErrorBanner(msg.code, msg.message);
}

/**
 * A 429 keeps the source text and retries automatically, but only a bounded
 * number of times. Several groups may report 429 for the same request; each
 * request counts as one attempt.
 */
function handleRateLimitError(msg: Extract<PortError, { type: "error" }>): void {
  const exhausted =
    rateLimitExhaustedRequestId === msg.requestId ||
    countRateLimitAttempt(msg.requestId) > MAX_RATE_LIMIT_RETRIES;

  if (exhausted) {
    rateLimitExhaustedRequestId = msg.requestId;
    failIds(msg.ids);
    clearRateLimitTimer();
    showErrorBanner(msg.code, msg.message, true);
    return;
  }

  for (const id of msg.ids) {
    registry.setStatus(id, "queued");
    deltaBuffers.delete(id);
  }
  showErrorBanner(msg.code, msg.message);
  scheduleRateLimitRetry(rateLimitAttempts);
}

/** Count one automatic attempt per request; returns the current total. */
function countRateLimitAttempt(requestId: string): number {
  if (rateLimitAttemptedRequestId !== requestId) {
    rateLimitAttemptedRequestId = requestId;
    rateLimitAttempts += 1;
  }
  return rateLimitAttempts;
}

function failIds(ids: string[]): void {
  for (const id of ids) {
    registry.setStatus(id, "failed");
    deltaBuffers.delete(id);
    discardLoading(id);
  }
}

/** The current request ended: clear it and start the next batch exactly once. */
function completeRequest(requestId: string): void {
  if (requestId !== currentRequestId) return;
  currentRequestId = null;
  lastCompletedRequestId = requestId;
  deltaBuffers.clear();
  // A request that finished without any 429 ends the rate-limit episode.
  if (rateLimitAttemptedRequestId !== requestId) resetRateLimitAttempts();
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
    if (active) void rescan().catch(reportScanError);
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
    else void translatePage().catch(reportScanError);
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
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (text.length < 2) return;
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
  sendOpenChat(text, "explain", range);
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible" && active) {
    send({ type: "ping" });
  }
}

function startObserver(): void {
  if (observer || observerPaused) return;
  const body = document.body;
  if (!body) return;
  observer = new MutationObserver(handleMutations);
  observer.observe(body, { childList: true, subtree: true, characterData: true });
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
  for (const mutation of mutations) {
    if (mutation.type !== "characterData") continue;
    const target = mutation.target;
    const el = target instanceof Element ? target : target.parentElement;
    if (el?.closest(".ilmt-tr")) continue;
    const root = pieceRootFor(target, getSiteRule(document.location.href));
    if (!root) continue;
    if (root.hasAttribute("data-ilmt-p")) invalidatePieceRoot(root);
    else forgetPiecesInRoot(root);
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
    if (!active) return;
    void requestScan("dynamic", scanGeneration).catch(reportScanError);
  }, MUTATION_DEBOUNCE_MS);
}

/**
 * An edited piece root is stale: drop every translation it owns, its registry
 * records and delta buffers, its marker, and every cached anchor under it so
 * the next scan re-collects the edited text (including previously skipped
 * short/target-language pieces) under a fresh id.
 */
function invalidatePieceRoot(root: Element): void {
  const ids = (root.getAttribute("data-ilmt-p") ?? "").split(/\s+/).filter(Boolean);
  for (const id of ids) {
    root.ownerDocument.querySelector(`[data-ilmt-for="${id}"]`)?.remove();
    registry.remove(id);
    gloss.removeParagraph(id);
    deltaBuffers.delete(id);
  }
  root.removeAttribute("data-ilmt-p");
  forgetPiecesInRoot(root);
  visibility?.unobserve(root);
}

async function enqueueNewParagraphs(generation: number): Promise<void> {
  if (!active || observerPaused || generation !== scanGeneration) return;
  const body = document.body;
  if (!body) return;

  const nodes = await collectParagraphs(body, {
    targetLang,
    minLength: minParagraphLength,
    contentOnly,
    detectLang: detectLang,
    url: document.location.href,
  });

  // Cancelled or paused mid-scan: undo exactly the marks this scan added.
  if (!active || observerPaused || generation !== scanGeneration) {
    unmarkNodes(nodes);
    return;
  }
  if (nodes.length === 0) return;

  if (!reserveDynamicSlots(nodes.length)) {
    unmarkNodes(nodes);
    pauseObservation();
    return;
  }
  registerScannedNodes(nodes);
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
  pruneTimer = setInterval(() => {
    registry.prune();
    pruneOrphanTranslations();
    visibility?.pruneDetached();
  }, PRUNE_INTERVAL_MS);
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
function describeError(
  code: string,
  message: string,
  rateLimitExhausted = false,
): ErrorPresentation {
  switch (code) {
    case "auth":
      return { text: "API key 无效或权限不足", settings: true, retry: false };
    case "rate_limit":
      return {
        text: rateLimitExhausted
          ? "请求过于频繁，请稍后手动重试"
          : "请求过于频繁，稍后自动重试",
        settings: false,
        retry: true,
      };
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

/**
 * Make the hover affordance discoverable: a bare dotted underline is easy to
 * miss, and "no annotations this time" is otherwise indistinguishable from a
 * broken feature.
 */
function updateActiveBannerHint(): void {
  const text = activeBanner?.querySelector(".ilmt-active-text");
  if (!text) return;
  const count = gloss.count();
  text.textContent =
    count > 0
      ? `翻译已开启 · ${count} 个词可悬停（带虚线的词）`
      : "翻译已开启 · 本次没有可悬停的注释";
}

function removeActiveBanner(): void {
  activeBanner?.remove();
  activeBanner = null;
}

/** One error banner at a time, never auto-closed, with an explicit `×`. */
function showErrorBanner(code: string, message: string, rateLimitExhausted = false): void {
  const presentation = describeError(code, message, rateLimitExhausted);
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
  resetRateLimitAttempts();
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

function scheduleRateLimitRetry(attempt: number): void {
  rateLimitHold = true;
  if (rateLimitTimer !== null) return;
  const delay = Math.min(
    RATE_LIMIT_RETRY_MS * 2 ** Math.max(0, attempt - 1),
    RATE_LIMIT_RETRY_MAX_MS,
  );
  rateLimitTimer = setTimeout(() => {
    rateLimitTimer = null;
    rateLimitHold = false;
    pump();
  }, delay);
}

function clearRateLimitTimer(): void {
  rateLimitHold = false;
  if (rateLimitTimer !== null) {
    clearTimeout(rateLimitTimer);
    rateLimitTimer = null;
  }
}

function resetRateLimitAttempts(): void {
  rateLimitAttempts = 0;
  rateLimitAttemptedRequestId = null;
  rateLimitExhaustedRequestId = null;
}

interface CollectPrefs {
  targetLang: string;
  minParagraphLength: number;
  contentOnly: boolean;
  learningLangs: string[];
  mascot: EffectSettings;
}

async function readCollectPrefs(): Promise<CollectPrefs> {
  try {
    const s = await getSettings();
    return {
      targetLang:
        typeof s.targetLang === "string" && s.targetLang.length > 0
          ? s.targetLang
          : DEFAULT_TARGET_LANG,
      minParagraphLength: s.minParagraphLength,
      contentOnly: s.contentOnly,
      learningLangs: s.learningLangs,
      mascot: s.mascot,
    };
  } catch {
    // Missing or unreadable storage: keep the documented defaults.
    return {
      targetLang: DEFAULT_TARGET_LANG,
      minParagraphLength: DEFAULT_SETTINGS.minParagraphLength,
      contentOnly: DEFAULT_SETTINGS.contentOnly,
      learningLangs: [...DEFAULT_SETTINGS.learningLangs],
      mascot: DEFAULT_SETTINGS.mascot,
    };
  }
}

/**
 * `chrome.i18n.detectLanguage` wrapper. Chrome has shipped both the callback
 * and the promise shape; accept either. Failures degrade to `null`, which
 * makes `collectParagraphs` use its CJK heuristic.
 */
async function detectLang(text: string): Promise<LanguageDetection | null> {
  if (langCache.has(text)) return langCache.get(text) ?? null;
  const detected = await detectLanguage(text);
  if (langCache.size >= LANG_CACHE_LIMIT) langCache.clear();
  langCache.set(text, detected);
  return detected;
}

function detectLanguage(text: string): Promise<LanguageDetection | null> {
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

/**
 * Reduce `chrome.i18n.detectLanguage`'s 0–100 per-language shares to the
 * dominant language and its aggregate share (0–1). Variants of the same
 * language (`zh-Hans`, `zh-Hant`) are summed before choosing the winner.
 */
function topLanguage(result: unknown): LanguageDetection | null {
  const languages = (result as { languages?: Array<{ language?: unknown; percentage?: unknown }> })
    ?.languages;
  if (!Array.isArray(languages) || languages.length === 0) return null;

  const totals = new Map<string, number>();
  const languageByPrefix = new Map<string, string>();
  for (const candidate of languages) {
    if (typeof candidate.language !== "string" || candidate.language.length === 0) continue;
    const prefix = languagePrefix(candidate.language);
    if (prefix.length === 0) continue;
    const percentage = Number(candidate.percentage);
    totals.set(prefix, (totals.get(prefix) ?? 0) + (Number.isFinite(percentage) ? percentage : 0));
    if (!languageByPrefix.has(prefix)) languageByPrefix.set(prefix, candidate.language);
  }
  if (totals.size === 0) return null;

  let bestPrefix = "";
  let bestTotal = -1;
  for (const [prefix, total] of totals) {
    if (total > bestTotal) {
      bestPrefix = prefix;
      bestTotal = total;
    }
  }
  const language = languageByPrefix.get(bestPrefix);
  if (!language) return null;
  return { language, percentage: Math.max(0, Math.min(1, bestTotal / 100)) };
}

function languagePrefix(lang: string): string {
  return (lang.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "");
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
