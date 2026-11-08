/**
 * Per-paragraph translation state registry for the content script.
 *
 * Holds one `ParagraphRecord` per detected paragraph. The DOM element and its
 * text-node anchor are kept as `WeakRef`s so a re-render (SPA, virtual DOM)
 * that drops a node can be garbage-collected instead of leaking through the
 * registry (spec §8.4). The record still carries a strong
 * `sourceText`/`translation`, so callers can act on a result even after the
 * element is gone.
 *
 * `WeakRef` is available in the target environments (Chrome ≥ 84, Node ≥ 14.6,
 * which jsdom runs on), so no fallback is needed. `prune()` reads `deref()` and
 * `isConnected` defensively and never throws.
 */

import type { ParagraphStatus } from "../shared/types";
import type { ParagraphNode } from "./paragraphs";

export interface ParagraphRecord {
  id: string;
  el: WeakRef<Element>;
  anchor: WeakRef<Node>;
  heading: boolean;
  sourceText: string;
  status: ParagraphStatus;
  translation?: string;
}

export class ParagraphRegistry {
  private readonly records = new Map<string, ParagraphRecord>();

  /** Register a detected paragraph. Re-adding an id replaces the record. */
  add(p: ParagraphNode): void {
    this.records.set(p.id, {
      id: p.id,
      el: new WeakRef(p.el),
      anchor: new WeakRef(p.anchor),
      heading: p.heading,
      sourceText: p.text,
      status: "unseen",
    });
  }

  get(id: string): ParagraphRecord | undefined {
    return this.records.get(id);
  }

  setStatus(id: string, status: ParagraphStatus): void {
    const record = this.records.get(id);
    if (record) record.status = status;
  }

  setTranslation(id: string, translation: string): void {
    const record = this.records.get(id);
    if (record) record.translation = translation;
  }

  /** Drop one record (an edited paragraph must be re-collected under a fresh id). */
  remove(id: string): void {
    this.records.delete(id);
  }

  /**
   * Take up to `limit` `queued` records in insertion order (FIFO) and mark them
   * `inflight`. Returns the records that were taken.
   */
  takeQueued(limit: number): ParagraphRecord[] {
    const taken: ParagraphRecord[] = [];
    for (const record of this.records.values()) {
      if (taken.length >= limit) break;
      if (record.status === "queued") {
        record.status = "inflight";
        taken.push(record);
      }
    }
    return taken;
  }

  /**
   * Return every `inflight` record to `queued` (port disconnect). Returns the
   * affected ids so the caller can re-prioritize them.
   */
  requeueInflight(): string[] {
    const ids: string[] = [];
    for (const record of this.records.values()) {
      if (record.status === "inflight") {
        record.status = "queued";
        ids.push(record.id);
      }
    }
    return ids;
  }

  /**
   * Remove records whose element or anchor was collected or detached; returns
   * the count. Both must stay connected: the anchor is where Task 5 inserts the
   * translation, so a missing anchor invalidates the piece even if its root
   * survives.
   */
  prune(): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      const el = record.el.deref();
      const anchor = record.anchor.deref();
      if (
        el === undefined ||
        !el.isConnected ||
        anchor === undefined ||
        !anchor.isConnected
      ) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }

  all(): ParagraphRecord[] {
    return Array.from(this.records.values());
  }
}
