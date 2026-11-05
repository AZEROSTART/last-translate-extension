/**
 * Paragraph detection for the content script.
 *
 * Traverses the page depth-first and picks the deepest block container whose
 * element children are all inline-level. A hit is marked with `data-ilmt-p`
 * so later scans and renders can find it; a miss keeps descending, so a
 * `<div>` wrapping `<p>` children never wins over the `<p>` elements.
 *
 * Page text is never mutated: apart from the marker attribute, everything here
 * is read-only.
 */

export interface ParagraphNode {
  id: string;
  el: Element;
  text: string;
}

interface CollectOptions {
  /** Minimum trimmed text length; shorter candidates are skipped. */
  minLength?: number;
  /** Share of detections that must match `targetLang` before skipping. */
  langSkipRatio?: number;
  /** Optional language detector; a `null` result falls back to the CJK heuristic. */
  detectLang?: (text: string) => Promise<string | null>;
  /** BCP-47 target language used by the language-skip rule. */
  targetLang?: string;
}

/** Tags whose subtree is never translated. */
const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "pre",
  "code",
  "kbd",
  "samp",
  "textarea",
  "input",
  "select",
  "option",
  "svg",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
]);

/**
 * Block-level tags used as a fallback when jsdom/layout does not provide a
 * computed `display` value. Unknown tags default to inline, matching the HTML
 * default for custom elements.
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

const DEFAULT_MIN_LENGTH = 4;
const DEFAULT_LANG_SKIP_RATIO = 0.8;
const DEFAULT_TARGET_LANG = "zh-CN";
const CJK_SKIP_RATIO = 0.6;

/** Module-global so ids never repeat across scans in one content script. */
let paragraphIdCounter = 0;

export function markParagraph(el: Element, id: string): void {
  el.setAttribute("data-ilmt-p", id);
}

export function isMarked(el: Element): boolean {
  return el.hasAttribute("data-ilmt-p");
}

export function clearMarks(root: ParentNode): void {
  if (root instanceof Element && isMarked(root)) {
    root.removeAttribute("data-ilmt-p");
  }
  for (const el of root.querySelectorAll("[data-ilmt-p]")) {
    el.removeAttribute("data-ilmt-p");
  }
}

export async function collectParagraphs(
  root: ParentNode,
  opts: CollectOptions = {},
): Promise<ParagraphNode[]> {
  const {
    minLength = DEFAULT_MIN_LENGTH,
    langSkipRatio = DEFAULT_LANG_SKIP_RATIO,
    detectLang,
    targetLang = DEFAULT_TARGET_LANG,
  } = opts;

  const candidates = collectCandidates(resolveScope(root));
  const nodes: ParagraphNode[] = [];

  for (const el of candidates) {
    const text = (el.textContent ?? "").trim();
    if (text.length < minLength) continue;
    if (await isAlreadyTargetLang(text, detectLang, langSkipRatio, targetLang)) continue;

    const id = `p_${++paragraphIdCounter}`;
    markParagraph(el, id);
    nodes.push({ id, el, text });
  }

  return nodes;
}

/** `<main>` → `<article>` → `[role=main]` → the given root (or `document.body`). */
function resolveScope(root: ParentNode): ParentNode {
  const scoped =
    findInScope(root, "main") ?? findInScope(root, "article") ?? findInScope(root, "[role=main]");
  if (scoped) return scoped;
  if (root instanceof Document) return root.body ?? root.documentElement;
  return root;
}

function findInScope(root: ParentNode, selector: string): Element | null {
  if (root instanceof Element && root.matches(selector)) return root;
  return root.querySelector(selector);
}

/** Depth-first; a hit is a leaf for this traversal, a skip drops its subtree. */
function collectCandidates(scope: ParentNode): Element[] {
  const candidates: Element[] = [];
  const stack: Element[] = [];
  const seed =
    scope instanceof Element ? [scope] : Array.from(scope.children);

  for (let i = seed.length - 1; i >= 0; i--) stack.push(seed[i]);

  while (stack.length > 0) {
    const el = stack.pop()!;
    if (shouldSkip(el)) continue;
    if (isParagraphCandidate(el)) {
      candidates.push(el);
      continue;
    }
    const children = Array.from(el.children);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  return candidates;
}

function shouldSkip(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;

  if (el.hasAttribute("contenteditable")) return true;
  if (el.getAttribute("aria-hidden")?.toLowerCase() === "true") return true;
  if (el.getAttribute("translate")?.toLowerCase() === "no") return true;
  if (el.classList.contains("notranslate")) return true;
  if (isMarked(el)) return true;
  if (el.classList.contains("ilmt-tr")) return true;

  const style = computedStyle(el);
  if (style) {
    if (style.display === "none") return true;
    if (style.visibility === "hidden") return true;
  }

  return false;
}

function isParagraphCandidate(el: Element): boolean {
  const text = el.textContent;
  if (!text || text.trim().length === 0) return false;
  return Array.from(el.children).every(isInlineLevel);
}

function isInlineLevel(el: Element): boolean {
  const display = computedStyle(el)?.display.trim().toLowerCase() ?? "";

  if (display.length > 0) {
    return display.startsWith("inline") || display.startsWith("contents");
  }

  // No layout information: infer from the tag's default display.
  return !BLOCK_TAGS.has(el.tagName.toLowerCase());
}

function computedStyle(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument.defaultView;
  return view ? view.getComputedStyle(el) : null;
}

async function isAlreadyTargetLang(
  text: string,
  detectLang: CollectOptions["detectLang"],
  langSkipRatio: number,
  targetLang: string,
): Promise<boolean> {
  if (detectLang) {
    let detected: string | null = null;
    try {
      detected = await detectLang(text);
    } catch {
      detected = null;
    }
    if (detected) {
      const matches = languagePrefix(detected) === languagePrefix(targetLang);
      return matches && 1 >= langSkipRatio;
    }
    // Detection failed: fall through to the character heuristic.
  }

  if (languagePrefix(targetLang) !== "zh") return false;
  return cjkShare(text) >= CJK_SKIP_RATIO;
}

function languagePrefix(lang: string): string {
  return (lang.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "");
}

function cjkShare(text: string): number {
  const chars = Array.from(text).filter((ch) => !/\s/.test(ch));
  if (chars.length === 0) return 0;
  const cjk = chars.filter((ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)).length;
  return cjk / chars.length;
}
