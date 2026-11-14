/**
 * Hover glossary: paint annotated source terms with the CSS Custom Highlight
 * API and show a small card when the pointer rests on one. The page DOM is
 * never wrapped or mutated; only a fixed-position card is appended.
 */

import type {
  EffectSettings,
  GlossaryNote,
  LearnWordMessage,
  LearnWordResponse,
} from "../shared/types";
import { findSurfaceRange } from "./glossary-range";
import { getEffect, getEffects, pickEffect } from "./effects";
import type { ClaimEffect, ClaimHandle, ClaimPhase, ClaimResult } from "./effects/types";
import "./effects/gopher-hole";
import "./effects/magnet";

const HIGHLIGHT_NAME = "ilmt-gloss";
const SHOW_DELAY_MS = 120;
const HIDE_DELAY_MS = 180;
const MAX_ENTRIES = 500;
const EFFECT_HISTORY_KEY = "ilmt:effect-history";

interface GlossEntry {
  paragraphId: string;
  node: Text;
  start: number;
  end: number;
  range: Range;
  note: GlossaryNote;
  termLang?: string;
  sentence: string;
  pageUrl: string;
  pageTitle?: string;
}

interface NodeHit {
  start: number;
  end: number;
  entry: GlossEntry;
}

/** Window of the source paragraph around a surface, capped for storage. */
function sentenceAround(text: string, surface: string): string {
  const index = text.toLocaleLowerCase().indexOf(surface.toLocaleLowerCase());
  if (index < 0) return text.trim().slice(0, 240);
  const from = Math.max(0, index - 80);
  const to = Math.min(text.length, index + surface.length + 120);
  return text.slice(from, to).trim().slice(0, 240);
}

export interface GlossController {
  start(): void;
  stop(): void;
  setParagraph(
    id: string,
    textNodes: Node[],
    notes: GlossaryNote[],
    termLang?: string,
  ): void;
  removeParagraph(id: string): void;
  prune(liveIds: Set<string>): void;
  clear(): void;
  /** Number of annotated ranges currently registered for hover. */
  count(): number;
}

export interface GlossControllerDeps {
  now?: () => number;
  sendLearn?: (message: LearnWordMessage) => Promise<LearnWordResponse | null>;
  /** Overrides rotation entirely (used by tests). */
  resolveEffect?: () => ClaimEffect;
  /** Live effect settings; read when a card opens so mode changes apply. */
  getEffectSettings?: () => EffectSettings | undefined;
  /** Current translation language, used as the card's answer language. */
  getGlossLang?: () => string;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface HighlightCSS {
  highlights?: HighlightRegistry;
}

export function createGlossController(
  doc: Document = document,
  deps: GlossControllerDeps = {},
): GlossController {
  const view = doc.defaultView;
  let entries: GlossEntry[] = [];
  const byNode = new Map<Text, NodeHit[]>();
  let card: HTMLElement | null = null;
  let pendingEntry: GlossEntry | null = null;
  let currentEntry: GlossEntry | null = null;
  let cardEffect: ClaimHandle | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverCard = false;
  let started = false;
  let scheduled = false;
  let lastPoint: { x: number; y: number } | null = null;
  /** Per-word outcome, so a reopened card never resends or forgets "known". */
  const captured = new Map<string, ClaimPhase>();

  function highlightParts(): { css: HighlightCSS | undefined; ctor: HighlightCtor | undefined } {
    const win = (view ?? globalThis) as unknown as {
      CSS?: HighlightCSS;
      Highlight?: HighlightCtor;
    };
    return {
      css: win.CSS ?? (globalThis as unknown as { CSS?: HighlightCSS }).CSS,
      ctor: win.Highlight ?? (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight,
    };
  }

  function rebuildHighlight(): void {
    const { css, ctor } = highlightParts();
    if (!css?.highlights || !ctor) return;
    if (entries.length === 0) {
      css.highlights.delete(HIGHLIGHT_NAME);
      return;
    }
    css.highlights.set(
      HIGHLIGHT_NAME,
      new ctor(...entries.map((entry) => entry.range)),
    );
  }

  function clearShowTimer(): void {
    if (showTimer !== undefined) {
      clearTimeout(showTimer);
      showTimer = undefined;
    }
    pendingEntry = null;
  }

  function cancelHide(): void {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  }

  /** Leaving the word keeps the card for a moment so the pointer can reach it. */
  function scheduleHide(): void {
    cancelHide();
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      if (!hoverCard) hideCard();
    }, HIDE_DELAY_MS);
  }

  function hideCard(): void {
    clearShowTimer();
    cancelHide();
    hoverCard = false;
    currentEntry = null;
    cardEffect?.destroy();
    cardEffect = null;
    if (card) {
      card.remove();
      card = null;
    }
  }

  function hideOrSchedule(): void {
    if (card) scheduleHide();
    else hideCard();
  }

  function pointInsideCard(x: number, y: number): boolean {
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function readEffectHistory(): string[] {
    try {
      const raw = view?.sessionStorage?.getItem(EFFECT_HISTORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === "string").slice(-2);
    } catch {
      return [];
    }
  }

  function writeEffectHistory(ids: string[]): void {
    try {
      view?.sessionStorage?.setItem(EFFECT_HISTORY_KEY, JSON.stringify(ids.slice(-2)));
    } catch {
      // Private mode or blocked storage; rotation just restarts.
    }
  }

  function nextEffect(): ClaimEffect {
    if (deps.resolveEffect) return deps.resolveEffect();
    const settings = deps.getEffectSettings?.();
    if (settings?.mode === "fixed") {
      const fixed = settings.fixedId ? getEffect(settings.fixedId) : undefined;
      if (fixed) return fixed;
      const all = getEffects();
      if (all.length > 0) return all[0];
    }
    const history = readEffectHistory();
    let effect: ClaimEffect;
    try {
      effect = pickEffect({ enabledIds: settings?.enabledIds ?? [], lastPicks: history });
    } catch {
      effect = getEffects()[0];
    }
    writeEffectHistory([...history, effect.id]);
    return effect;
  }

  function animationsAllowed(): boolean {
    if (deps.getEffectSettings?.()?.animations === false) return false;
    try {
      return !(view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    } catch {
      return true;
    }
  }

  let styleEl: HTMLStyleElement | null = null;

  /** Inject every registered effect's CSS once per document. */
  function ensureEffectStyles(): void {
    if (styleEl?.isConnected) return;
    const css = getEffects()
      .map((effect) => effect.css ?? "")
      .join("\n");
    if (!css.trim()) return;
    styleEl = doc.createElement("style");
    styleEl.dataset.ilmtEffects = "";
    styleEl.textContent = css;
    (doc.head ?? doc.documentElement).appendChild(styleEl);
  }

  function entryKey(entry: GlossEntry): string {
    return `${entry.termLang ?? ""}:${entry.note.surface.trim().toLocaleLowerCase()}`;
  }

  function fallbackTermLang(): string {
    const lang = doc.documentElement.getAttribute("lang") ?? "";
    return lang.trim().toLowerCase().split(/[-_]/)[0] || "en";
  }

  async function defaultSendLearn(message: LearnWordMessage): Promise<LearnWordResponse | null> {
    try {
      const response = await chrome.runtime.sendMessage(message);
      return (response ?? null) as LearnWordResponse | null;
    } catch {
      return null;
    }
  }

  function positionCard(element: HTMLElement, range: Range): void {
    const rect = range.getBoundingClientRect();
    const cardRect = element.getBoundingClientRect();
    const width = cardRect.width || element.offsetWidth || 280;
    const height = cardRect.height || element.offsetHeight || 80;
    const maxLeft = Math.max(8, (view?.innerWidth ?? 0) - width - 8);
    const left = Math.min(Math.max(8, rect.left), maxLeft);
    const top = rect.top >= height + 8 ? rect.top - height - 8 : rect.bottom + 8;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  function showCard(entry: GlossEntry): void {
    if (!doc.body) return;

    const element = doc.createElement("div");
    element.className = "ilmt-gloss-card";
    element.setAttribute("role", "tooltip");

    const word = doc.createElement("div");
    word.className = "ilmt-gloss-word";
    const surface = doc.createElement("span");
    surface.className = "ilmt-gloss-surface";
    surface.textContent = entry.note.surface;
    word.appendChild(surface);
    if (entry.note.pos) {
      const pos = doc.createElement("span");
      pos.className = "ilmt-gloss-pos";
      pos.textContent = entry.note.pos;
      word.appendChild(pos);
    }

    const meaning = doc.createElement("div");
    meaning.className = "ilmt-gloss-meaning";
    meaning.textContent = entry.note.meaning;
    element.append(word, meaning);

    if (entry.note.example) {
      const example = doc.createElement("div");
      example.className = "ilmt-gloss-example";
      example.textContent = entry.note.example;
      element.appendChild(example);
    }

    ensureEffectStyles();

    const effect = nextEffect();
    const key = entryKey(entry);

    // The effect paints "already captured" itself; this region is screen-reader only.
    const announce = doc.createElement("div");
    announce.className = "ilmt-gloss-sr-only";
    announce.setAttribute("aria-live", "polite");

    const host = doc.createElement("div");
    host.className = "ilmt-gloss-effect-host";

    let claiming = false;
    const claim = async (): Promise<ClaimResult> => {
      if (captured.has(key)) return { ok: true, created: false };
      if (claiming) return { ok: false, created: false };
      claiming = true;
      const message: LearnWordMessage = {
        type: "learn-word",
        surface: entry.note.surface,
        termLang: entry.termLang ?? fallbackTermLang(),
        glossLang: deps.getGlossLang?.() ?? "zh-CN",
        meaning: entry.note.meaning,
        sentence: entry.sentence,
        pageUrl: entry.pageUrl,
        ...(entry.note.pos ? { pos: entry.note.pos } : {}),
        ...(entry.note.glosses ? { glosses: entry.note.glosses } : {}),
        ...(entry.pageTitle ? { pageTitle: entry.pageTitle } : {}),
        mascotId: effect.id,
      };
      const send = deps.sendLearn ?? defaultSendLearn;
      try {
        const response = await send(message);
        if (!response?.ok) return { ok: false, created: false };
        // Remember only the quiet end state: reopening the card must not
        // replay the "+1" animation.
        captured.set(key, "known");
        return { ok: true, created: response.created };
      } finally {
        claiming = false;
      }
    };

    word.appendChild(host);
    element.appendChild(announce);
    doc.body.appendChild(element);

    card = element;
    currentEntry = entry;
    pendingEntry = null;
    showTimer = undefined;

    cardEffect = effect.mount({
      doc,
      surface,
      root: host,
      // `.ilmt-card` has one light palette today; see the note below.
      theme: "light",
      animations: animationsAllowed(),
      claim,
      announce: (text) => {
        announce.textContent = text;
      },
      label: (verb) => `把${effect.label}${verb}下去，收录这个单词`,
    });

    // reserve: above grows the word row, below pushes the meaning down
    if (effect.reserve.above > 0) word.style.paddingTop = `${effect.reserve.above}px`;
    if (effect.reserve.below > 0) word.style.marginBottom = `${effect.reserve.below}px`;

    const stored = captured.get(key);
    if (stored) cardEffect.setState(stored);

    positionCard(element, entry.range);
  }

  function hitTest(): void {
    if (!lastPoint) return;
    const { x, y } = lastPoint;

    let node: Node | undefined;
    let offset = 0;
    const caret = (doc as unknown as {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    }).caretPositionFromPoint?.(x, y);
    if (caret) {
      node = caret.offsetNode;
      offset = caret.offset;
    } else {
      const range = (doc as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      }).caretRangeFromPoint?.(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }

    if (!node || node.nodeType !== Node.TEXT_NODE) {
      hideOrSchedule();
      return;
    }

    const hit = byNode
      .get(node as Text)
      ?.find((item) => offset >= item.start && offset < item.end)?.entry;
    if (!hit) {
      hideOrSchedule();
      return;
    }
    if (currentEntry === hit) {
      cancelHide();
      return;
    }

    clearShowTimer();
    hideCard();
    pendingEntry = hit;
    showTimer = setTimeout(() => {
      showTimer = undefined;
      const entry = pendingEntry;
      pendingEntry = null;
      if (entry) showCard(entry);
    }, SHOW_DELAY_MS);
  }

  function scheduleHitTest(): void {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      hitTest();
    };
    const raf =
      (globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
        .requestAnimationFrame ??
      (view as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number } | null)
        ?.requestAnimationFrame;
    if (raf) raf(run);
    else run();
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    if (pointInsideCard(event.clientX, event.clientY)) {
      hoverCard = true;
      cancelHide();
      return;
    }
    hoverCard = false;
    const selection = doc.getSelection?.();
    if (selection && !selection.isCollapsed) {
      hideCard();
      return;
    }
    lastPoint = { x: event.clientX, y: event.clientY };
    scheduleHitTest();
  }

  function onScroll(): void {
    hideCard();
  }

  function onBlur(): void {
    hideCard();
  }

  function onSelectionChange(): void {
    const selection = doc.getSelection?.();
    if (selection && !selection.isCollapsed) hideCard();
  }

  function dropEntries(predicate: (entry: GlossEntry) => boolean): boolean {
    const doomed = entries.filter(predicate);
    if (doomed.length === 0) return false;

    entries = entries.filter((entry) => !predicate(entry));
    for (const entry of doomed) {
      const hits = byNode.get(entry.node);
      if (!hits) continue;
      const remaining = hits.filter((hit) => hit.entry !== entry);
      if (remaining.length === 0) byNode.delete(entry.node);
      else byNode.set(entry.node, remaining);
    }

    if (
      (currentEntry && predicate(currentEntry)) ||
      (pendingEntry && predicate(pendingEntry))
    ) {
      hideCard();
    }
    return true;
  }

  function removeParagraph(id: string): void {
    if (dropEntries((entry) => entry.paragraphId === id)) rebuildHighlight();
  }

  function clear(): void {
    entries = [];
    byNode.clear();
    rebuildHighlight();
    hideCard();
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      doc.addEventListener("pointermove", onPointerMove, { passive: true });
      doc.addEventListener("selectionchange", onSelectionChange);
      view?.addEventListener("scroll", onScroll, true);
      view?.addEventListener("blur", onBlur);
    },

    stop(): void {
      if (!started) return;
      started = false;
      doc.removeEventListener("pointermove", onPointerMove);
      doc.removeEventListener("selectionchange", onSelectionChange);
      view?.removeEventListener("scroll", onScroll, true);
      view?.removeEventListener("blur", onBlur);
      clear();
    },

    setParagraph(
      id: string,
      textNodes: Node[],
      notes: GlossaryNote[],
      termLang?: string,
    ): void {
      removeParagraph(id);

      const paragraphText = textNodes
        .map((text) => text.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const pageUrl = doc.location?.href ?? "";
      const pageTitle = doc.title || undefined;

      for (const note of notes) {
        if (entries.length >= MAX_ENTRIES) break;
        const range = findSurfaceRange(textNodes, note.surface);
        if (!range) continue;
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const start = range.startOffset;
        const end = range.endOffset;
        if (start >= end) continue;
        if (
          entries.some(
            (entry) =>
              entry.node === node && start < entry.end && end > entry.start,
          )
        ) {
          continue;
        }

        const entry: GlossEntry = {
          paragraphId: id,
          node: node as Text,
          start,
          end,
          range,
          note,
          termLang,
          sentence: sentenceAround(paragraphText, note.surface),
          pageUrl,
          ...(pageTitle ? { pageTitle } : {}),
        };
        entries.push(entry);
        const hits = byNode.get(entry.node) ?? [];
        hits.push({ start, end, entry });
        byNode.set(entry.node, hits);
      }

      rebuildHighlight();
    },

    removeParagraph,

    prune(liveIds: Set<string>): void {
      if (dropEntries((entry) => !liveIds.has(entry.paragraphId))) rebuildHighlight();
    },

    clear,

    count(): number {
      return entries.length;
    },
  };
}
