/**
 * Local page context for a text selection: the containing block's source
 * text, up to two preceding blocks, and the nearest heading.
 *
 * This is intentionally a small, deterministic extraction. It never mutates
 * the page, strips our injected translation spans, and caps every piece so a
 * long article cannot flood the chat request. A missing or unusable selection
 * simply returns `undefined`; chat must still work without it.
 */

import type { SelectionContext } from "../shared/types";
import { extractSourceText } from "./render";

const BLOCK_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "td",
  "th",
  "dd",
  "dt",
  "figcaption",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "section",
  "article",
].join(",");

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** Caps chosen to keep the assistant focused without losing the local thread. */
const MAX_PARAGRAPH = 1000;
const MAX_PRECEDING = 500;
const MAX_HEADING = 120;
const MAX_PRECEDING_BLOCKS = 2;
/** Share of a truncated paragraph kept before the selected text. */
const BEFORE_BUDGET = 600;

/**
 * Build the selection-local context from a snapshot of the user's range.
 * Returning `undefined` is the normal fallback for selections outside a
 * recognizable block (for example, bare body text or a detached node).
 */
export function buildSelectionContext(range: Range): SelectionContext | undefined {
  const block = blockFor(range.startContainer);
  if (!block) return undefined;

  const selected = normalize(range.toString());
  const paragraph = capParagraph(normalize(extractSourceText(block)), selected);
  if (!paragraph) return undefined;

  const heading = nearestHeading(block);
  return {
    ...(heading ? { heading } : {}),
    paragraph,
    preceding: precedingBlocks(block),
  };
}

/** Nearest block-level ancestor, falling back to the node's parent element. */
function blockFor(node: Node): Element | undefined {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return undefined;

  const block = element.closest(BLOCK_SELECTOR);
  if (!block || block === document.body || block === document.documentElement) return undefined;
  return block;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keep the selection visible, preferring text before it, when truncating. */
function capParagraph(text: string, selected: string): string {
  if (text.length <= MAX_PARAGRAPH) return text;

  const index = selected ? text.indexOf(selected) : -1;
  if (index < 0) return capText(text, MAX_PARAGRAPH);

  const start = Math.max(0, index - BEFORE_BUDGET);
  const end = Math.min(text.length, start + MAX_PARAGRAPH);
  const excerpt = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Up to two previous sibling blocks, ordered oldest → nearest. */
function precedingBlocks(block: Element): string[] {
  const texts: string[] = [];
  let sibling = block.previousElementSibling;

  while (sibling && texts.length < MAX_PRECEDING_BLOCKS) {
    if (!sibling.matches(HEADING_SELECTOR)) {
      const text = normalize(blockText(sibling));
      if (text) texts.unshift(capText(text, MAX_PRECEDING));
    }
    sibling = sibling.previousElementSibling;
  }

  return texts;
}

/** Text of a sibling, preferring its last block descendant for wrappers. */
function blockText(element: Element): string {
  if (element.matches(BLOCK_SELECTOR)) return extractSourceText(element);
  const blocks = element.querySelectorAll(BLOCK_SELECTOR);
  if (blocks.length > 0) return extractSourceText(blocks[blocks.length - 1]);
  return extractSourceText(element);
}

/** Nearest heading in the preceding siblings, walking up through wrappers. */
function nearestHeading(block: Element): string | undefined {
  let current: Element | null = block;

  while (current && current !== document.body) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.matches(HEADING_SELECTOR)) {
        return capText(normalize(extractSourceText(sibling)), MAX_HEADING) || undefined;
      }
      const headings = sibling.querySelectorAll(HEADING_SELECTOR);
      if (headings.length > 0) {
        return capText(normalize(extractSourceText(headings[headings.length - 1])), MAX_HEADING) || undefined;
      }
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }

  return undefined;
}
