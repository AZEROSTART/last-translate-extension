/**
 * Translation rendering and restore for the content script.
 *
 * A translation is always a new `<span class="ilmt-tr ilmt-block">` node; the
 * page's own text nodes are never touched. The node is inserted at a "safe
 * anchor" derived from the piece root and anchor text node: inside the root,
 * after the anchor (and past trailing skipped inline nodes), or — for a row
 * flex that is not a scope/heading/table structure — after the root itself.
 * Headings always insert inside the heading and carry `data-ilmt-heading="1"`.
 * Each span carries `data-ilmt-for` so later deltas update it in place, and
 * `lang` so the browser applies the right font rules.
 *
 * `restoreAll` removes the spans and the paragraph marks again, leaving the
 * page exactly as it was before translation started.
 */

const TRANSLATION_CLASS = "ilmt-tr";
const DEFAULT_TARGET_LANG = "zh-CN";

/**
 * Base skip selectors used to decide whether a trailing node is "skippable"
 * when looking for the insertion point. Site-specific rules are deliberately
 * not threaded in here: inserting before a site-specific skipped inline node is
 * still safe, and the critical invariant — never placing a translation inside
 * a button or other interactive element — is guaranteed by this set.
 */
const RENDER_SKIP_SELECTOR = [
  "button",
  "[role='button']",
  "summary",
  "label",
  "select",
  "input",
  "textarea",
  "time",
  "relative-time",
  "[datetime]",
  "code",
  "kbd",
  "samp",
  "[contenteditable]",
  "[aria-hidden='true']",
  "[hidden]",
  ".sr-only",
  ".visually-hidden",
  "[translate='no']",
  ".notranslate",
  ".ilmt-tr",
].join(",");

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

/** Where to render a translation, resolved from a collected piece. */
export interface TranslationTarget {
  root: Element;
  anchor: Node;
  heading?: boolean;
}

/**
 * Renders (or refreshes) the translation for `id`. An existing node is updated
 * in place so a streamed result never leaves duplicates behind.
 */
export function renderTranslation(
  target: TranslationTarget,
  id: string,
  text: string,
  targetLang: string = DEFAULT_TARGET_LANG,
): HTMLElement {
  const { root } = target;

  const existing = findTranslation(root.ownerDocument, id);
  if (existing) {
    existing.textContent = text;
    existing.setAttribute("lang", targetLang);
    clearLoading(existing);
    return existing;
  }

  return createTranslationNode(target, id, text, targetLang, false);
}

/**
 * Inserts (or marks) a skeleton at the translation anchor while the request is
 * in flight. It is the same `.ilmt-tr` node the final translation will use, so
 * the result replaces the skeleton in place.
 */
export function renderLoading(
  target: TranslationTarget,
  id: string,
  targetLang: string = DEFAULT_TARGET_LANG,
): HTMLElement {
  const existing = findTranslation(target.root.ownerDocument, id);
  if (existing) {
    // A requeued piece may still hold partial streamed text. Drop it so the
    // retry shows a clean skeleton instead of a bar stacked over stale text.
    existing.textContent = "";
    markLoading(existing);
    return existing;
  }
  return createTranslationNode(target, id, "", targetLang, true);
}

/**
 * Removes an empty loading placeholder after a failure; a node that already
 * received partial streamed text only loses its loading marker.
 */
export function discardLoading(id: string): void {
  const node = findTranslation(document, id);
  if (!node) return;
  if (node.getAttribute("data-loading") === "1" && (node.textContent ?? "").trim() === "") {
    node.remove();
    return;
  }
  clearLoading(node);
}

function createTranslationNode(
  target: TranslationTarget,
  id: string,
  text: string,
  targetLang: string,
  loading: boolean,
): HTMLElement {
  const { root } = target;

  const node = root.ownerDocument.createElement("span");
  node.className = `${TRANSLATION_CLASS} ilmt-block`;
  node.setAttribute("data-ilmt-for", id);
  node.setAttribute("lang", targetLang);
  node.textContent = text;
  if (target.heading) node.setAttribute("data-ilmt-heading", "1");
  if (loading) markLoading(node);

  const display = displayOf(root);
  const isFlex = display.includes("flex");
  const isRow = isFlex && (flexDirection(root) || "row").startsWith("row");
  const scopeLike = root.matches(
    "body, main, article, [role='main'], #repo-content-turbo-frame, feed-container",
  );
  const canAfter = !root.matches(
    "td, th, tr, tbody, thead, tfoot, table, caption, colgroup, col, option, optgroup, select, textarea",
  );
  const afterRoot =
    !target.heading && isRow && !scopeLike && canAfter && root.parentElement !== null;

  if (afterRoot) {
    const parent = root.parentElement as Element;
    parent.insertBefore(node, root.nextSibling);
    addClass(node, breakClassFor(parent));
    return node;
  }

  // Anchor disconnected (SPA re-render): fall back to the end of the root when
  // the root itself is still in the document, otherwise return it uninserted.
  if (!target.anchor.isConnected) {
    if (root.isConnected) root.appendChild(node);
    return node;
  }

  // Walk up from the anchor to the safe insertion point: past inline wrappers
  // (stopping at a block boundary), and past a flex/grid item whose parent is
  // the root so the translation lands after the whole item.
  let anchorNode: Node = target.anchor;
  let parent: Node | null = anchorNode.parentNode;
  while (parent && parent !== root) {
    const parentEl = parent as Element;
    if (parentEl.parentNode === root && isFlexOrGrid(root)) {
      anchorNode = parentEl;
      parent = parentEl.parentNode;
      continue;
    }
    if (isBlockDisplay(parentEl)) break;
    anchorNode = parentEl;
    parent = parentEl.parentNode;
  }
  let ref: Node | null = anchorNode.nextSibling;
  while (ref && isSkippedInline(ref)) ref = ref.nextSibling;

  addClass(node, breakClassFor(root));
  if (parent) parent.insertBefore(node, ref);
  else root.appendChild(node);
  return node;
}

/** Replaces the text of an existing translation; does nothing if absent. */
export function updateTranslation(id: string, text: string): void {
  const node = findTranslation(document, id);
  if (node) node.textContent = text;
}

/**
 * Removes every translation node and paragraph mark under `root`, restoring
 * the page to its pre-translation shape (spec §8.3). The paragraph registry is
 * the caller's responsibility.
 */
export function restoreAll(root: ParentNode = document.body): void {
  const translations: Element[] = [];
  if (root instanceof Element && root.classList.contains(TRANSLATION_CLASS)) {
    translations.push(root);
  }
  translations.push(...root.querySelectorAll(`.${TRANSLATION_CLASS}`));
  for (const node of translations) node.remove();

  if (root instanceof Element && root.hasAttribute("data-ilmt-p")) {
    root.removeAttribute("data-ilmt-p");
  }
  for (const el of root.querySelectorAll("[data-ilmt-p]")) {
    el.removeAttribute("data-ilmt-p");
  }
}

/** The element's own text with any translation spans stripped out. */
export function extractSourceText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(`.${TRANSLATION_CLASS}`)) node.remove();
  return (clone.textContent ?? "").trim();
}

/** Marks the translation as pending (CSS renders the skeleton). */
export function setInlineLoader(id: string): void {
  const node = findTranslation(document, id);
  if (node) markLoading(node);
}

/** Clears the pending marker once the translation has been rendered. */
export function clearInlineLoader(id: string): void {
  const node = findTranslation(document, id);
  if (node) clearLoading(node);
}

function markLoading(node: HTMLElement): void {
  node.setAttribute("data-loading", "1");
  node.setAttribute("aria-busy", "true");
  node.setAttribute("aria-label", "翻译中");
}

function clearLoading(node: HTMLElement): void {
  node.removeAttribute("data-loading");
  node.removeAttribute("aria-busy");
  node.removeAttribute("aria-label");
}

function findTranslation(scope: ParentNode, id: string): HTMLElement | null {
  return scope.querySelector(`[data-ilmt-for="${id}"]`) as HTMLElement | null;
}

function addClass(node: HTMLElement, className: string | null): void {
  if (className) node.classList.add(className);
}

/**
 * Whether a trailing node can be skipped while looking for the insertion
 * point: whitespace text, a base-skip element that is still inline-displayed,
 * or one of our own translation nodes.
 */
function isSkippedInline(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").trim().length === 0;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.classList.contains(TRANSLATION_CLASS)) return true;
  return !isBlockDisplay(el) && matchesRenderSkip(el);
}

function matchesRenderSkip(el: Element): boolean {
  try {
    return el.matches(RENDER_SKIP_SELECTOR);
  } catch {
    return false;
  }
}

/**
 * The break class a translation needs given its containing layout: a grid gets
 * `ilmt-grid-break`, a row flex gets `ilmt-flex-break`, and a column flex gets
 * none (its block children already stack vertically).
 */
function breakClassFor(el: Element | null): string | null {
  if (!el) return null;
  const display = displayOf(el);
  if (display.includes("grid")) return "ilmt-grid-break";
  if (display.includes("flex")) {
    const dir = flexDirection(el) || "row";
    return dir.startsWith("row") ? "ilmt-flex-break" : null;
  }
  return null;
}

function isFlexOrGrid(el: Element): boolean {
  const display = displayOf(el);
  return display.includes("flex") || display.includes("grid");
}

function isBlockDisplay(el: Element): boolean {
  const display = displayOf(el);
  if (!display) return BLOCK_TAGS.has(el.tagName.toLowerCase());
  if (display === "none") return false;
  return !isInlineDisplay(display);
}

function isInlineDisplay(display: string): boolean {
  return (
    display === "inline" ||
    display.startsWith("inline-") ||
    display === "contents" ||
    display === "ruby" ||
    display === "ruby-base" ||
    display === "ruby-text" ||
    display === "math"
  );
}

/** Computed `display`, lowercased; empty when no layout is available. */
function displayOf(el: Element | null): string {
  if (!el) return "";
  const view = el.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return "";
  try {
    return (view.getComputedStyle(el).display ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

/** Computed `flex-direction`, lowercased; empty when no layout is available. */
function flexDirection(el: Element | null): string {
  if (!el) return "";
  const view = el.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return "";
  try {
    return (view.getComputedStyle(el).flexDirection ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}
