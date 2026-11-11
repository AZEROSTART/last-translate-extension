/**
 * Hover glossary: paint annotated source terms with the CSS Custom Highlight
 * API and show a small card when the pointer rests on one. The page DOM is
 * never wrapped or mutated; only a fixed-position card is appended.
 */

import type { GlossaryNote } from "../shared/types";
import { findSurfaceRange } from "./glossary-range";

const HIGHLIGHT_NAME = "ilmt-gloss";
const SHOW_DELAY_MS = 120;
const MAX_ENTRIES = 500;

interface GlossEntry {
  paragraphId: string;
  node: Text;
  start: number;
  end: number;
  range: Range;
  note: GlossaryNote;
}

interface NodeHit {
  start: number;
  end: number;
  entry: GlossEntry;
}

export interface GlossController {
  start(): void;
  stop(): void;
  setParagraph(id: string, textNodes: Node[], notes: GlossaryNote[]): void;
  removeParagraph(id: string): void;
  prune(liveIds: Set<string>): void;
  clear(): void;
  /** Number of annotated ranges currently registered for hover. */
  count(): number;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface HighlightCSS {
  highlights?: HighlightRegistry;
}

export function createGlossController(doc: Document = document): GlossController {
  const view = doc.defaultView;
  let entries: GlossEntry[] = [];
  const byNode = new Map<Text, NodeHit[]>();
  let card: HTMLElement | null = null;
  let pendingEntry: GlossEntry | null = null;
  let currentEntry: GlossEntry | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let scheduled = false;
  let lastPoint: { x: number; y: number } | null = null;

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

  function hideCard(): void {
    clearShowTimer();
    currentEntry = null;
    if (card) {
      card.remove();
      card = null;
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

    doc.body.appendChild(element);
    positionCard(element, entry.range);
    card = element;
    currentEntry = entry;
    pendingEntry = null;
    showTimer = undefined;
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
      hideCard();
      return;
    }

    const hit = byNode
      .get(node as Text)
      ?.find((item) => offset >= item.start && offset < item.end)?.entry;
    if (!hit) {
      hideCard();
      return;
    }
    if (currentEntry === hit) return;

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

    setParagraph(id: string, textNodes: Node[], notes: GlossaryNote[]): void {
      removeParagraph(id);

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
