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
import { SELECTION_CONTEXT_LIMITS as LIMITS } from "../shared/selection-context-limits";

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

/**
 * Nodes that must never become prose context: our own injected UI/translations,
 * executable/style content, and text hidden from the user.
 */
const SKIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "[hidden]",
  "[aria-hidden='true']",
  ".ilmt-tr",
  ".ilmt-bubble",
  ".ilmt-active-banner",
  ".ilmt-error-banner",
].join(",");

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
  if (!selected) return undefined;

  const paragraph = capParagraph(
    normalize(sourceText(block)),
    sourceOffset(block, range),
    selected,
  );
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
function capParagraph(text: string, offset: number, selected: string): string {
  if (text.length <= LIMITS.paragraph) return text;

  const index = offset >= 0 ? Math.min(offset, text.length) : selected ? text.indexOf(selected) : -1;
  if (index < 0) return capText(text, LIMITS.paragraph);

  const start = Math.max(0, index - BEFORE_BUDGET);
  const end = Math.min(text.length, start + LIMITS.paragraph);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const budget = LIMITS.paragraph - prefix.length - suffix.length;
  const excerpt = text.slice(start, start + budget).trim();
  return `${prefix}${excerpt}${suffix}`;
}

/**
 * Character offset of the range start inside the block's *source-only* text.
 * This keeps truncation anchored to the real selection even when an earlier
 * identical phrase exists, or when the selection starts in a translation node
 * that will be stripped from the paragraph.
 */
function sourceOffset(block: Element, range: Range): number {
  try {
    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);
    const fragment = before.cloneContents();
    for (const node of fragment.querySelectorAll(SKIP_SELECTOR)) node.remove();
    return normalize(fragment.textContent ?? "").length;
  } catch {
    return -1;
  }
}

/** Source text with our injected UI/translations and non-prose nodes removed. */
function sourceText(element: Element): string {
  if (element.matches(SKIP_SELECTOR)) return "";
  const clone = element.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(SKIP_SELECTOR)) node.remove();
  return (clone.textContent ?? "").trim();
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Up to two previous sibling blocks, ordered oldest → nearest. */
function precedingBlocks(block: Element): string[] {
  const texts: string[] = [];
  let sibling = block.previousElementSibling;

  while (sibling && texts.length < LIMITS.precedingBlocks) {
    // A heading starts a new section; earlier sections are not this paragraph's
    // immediate preceding context.
    if (sibling.matches(HEADING_SELECTOR)) break;
    if (!sibling.matches(SKIP_SELECTOR)) {
      const text = normalize(blockText(sibling));
      if (text) texts.unshift(capText(text, LIMITS.preceding));
    }
    sibling = sibling.previousElementSibling;
  }

  return texts;
}

/** Text of a sibling, preferring its last visible block descendant for wrappers. */
function blockText(element: Element): string {
  if (element.matches(SKIP_SELECTOR)) return "";
  if (element.matches(BLOCK_SELECTOR)) return sourceText(element);
  const blocks = [...element.querySelectorAll(BLOCK_SELECTOR)].filter(
    (block) => !block.matches(SKIP_SELECTOR) && !block.closest(SKIP_SELECTOR),
  );
  if (blocks.length > 0) return sourceText(blocks[blocks.length - 1]);
  // Inline controls/labels are not paragraphs; only block containers qualify.
  return "";
}

/** Nearest heading in the preceding siblings, walking up through wrappers. */
function nearestHeading(block: Element): string | undefined {
  let current: Element | null = block;

  while (current && current !== document.body) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.matches(SKIP_SELECTOR)) {
        sibling = sibling.previousElementSibling;
        continue;
      }
      if (sibling.matches(HEADING_SELECTOR)) {
        return capText(normalize(sourceText(sibling)), LIMITS.heading) || undefined;
      }
      const headings = [...sibling.querySelectorAll(HEADING_SELECTOR)].filter(
        (heading) => !heading.closest(SKIP_SELECTOR),
      );
      if (headings.length > 0) {
        return capText(normalize(sourceText(headings[headings.length - 1])), LIMITS.heading) || undefined;
      }
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }

  return undefined;
}
