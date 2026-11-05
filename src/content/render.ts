/**
 * Translation rendering and restore for the content script.
 *
 * A translation is always a new `<span class="ilmt-tr">` node; the page's own
 * text nodes are never touched. Block-level candidates get the span appended as
 * their last child, inline candidates get it as their next sibling. Each span
 * carries `data-ilmt-for` so later deltas update it in place, and `lang` so the
 * browser applies the right font rules.
 *
 * `restoreAll` removes the spans again, leaving the page's own text exactly as
 * it was before translation started.
 */

const TRANSLATION_CLASS = "ilmt-tr";
const DEFAULT_TARGET_LANG = "zh-CN";

/**
 * Tags whose default display is block-level. Used when the environment does not
 * provide a computed `display` value (jsdom returns an empty string), and as a
 * guard for detached elements. Unknown tags default to inline, matching HTML.
 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "legend",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/**
 * Renders (or refreshes) the translation for `id`. An existing node is updated
 * in place so a streamed result never leaves duplicates behind.
 */
export function renderTranslation(el: Element, id: string, text: string): HTMLElement {
  const existing = findTranslation(el.ownerDocument, id);
  if (existing) {
    existing.textContent = text;
    return existing;
  }

  const node = el.ownerDocument.createElement("span");
  const inline = isInline(el);
  node.className = `${TRANSLATION_CLASS} ${inline ? "ilmt-inline" : "ilmt-block"}`;
  node.setAttribute("data-ilmt-for", id);
  node.setAttribute("lang", DEFAULT_TARGET_LANG);
  node.textContent = text;

  if (inline && el.parentNode) {
    el.parentNode.insertBefore(node, el.nextSibling);
  } else {
    el.appendChild(node);
  }

  return node;
}

/** Replaces the text of an existing translation; does nothing if absent. */
export function updateTranslation(id: string, text: string): void {
  const node = findTranslation(document, id);
  if (node) node.textContent = text;
}

/**
 * Removes every translation node under `root`, restoring the page's own text
 * untouched. Paragraph marks are owned by paragraph detection (`clearMarks` in
 * `paragraphs.ts`) and deliberately survive here: the brief's restore test
 * snapshots the DOM with `data-ilmt-p` already set and requires it back
 * byte-for-byte, so this function only reverses what rendering added.
 */
export function restoreAll(root: ParentNode = document): void {
  const translations: Element[] = [];
  if (root instanceof Element && root.classList.contains(TRANSLATION_CLASS)) {
    translations.push(root);
  }
  translations.push(...root.querySelectorAll(`.${TRANSLATION_CLASS}`));
  for (const node of translations) node.remove();
}

/** The element's own text with any translation spans stripped out. */
export function extractSourceText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(`.${TRANSLATION_CLASS}`)) node.remove();
  return (clone.textContent ?? "").trim();
}

/** Marks the translation as pending (CSS lowers its opacity). */
export function setInlineLoader(id: string): void {
  const node = findTranslation(document, id);
  if (node) node.setAttribute("data-loading", "1");
}

/** Clears the pending marker once the translation has been rendered. */
export function clearInlineLoader(id: string): void {
  const node = findTranslation(document, id);
  if (node) node.removeAttribute("data-loading");
}

function findTranslation(scope: ParentNode, id: string): HTMLElement | null {
  return scope.querySelector(`[data-ilmt-for="${id}"]`) as HTMLElement | null;
}

/** Computed `display` wins; without layout information, fall back to the tag. */
function isInline(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  const display = view ? view.getComputedStyle(el).display.trim().toLowerCase() : "";
  if (display.length > 0) return display.startsWith("inline");
  return !BLOCK_TAGS.has(el.tagName.toLowerCase());
}
