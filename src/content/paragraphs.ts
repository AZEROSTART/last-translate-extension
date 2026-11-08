/**
 * Text-node piece collection for the content script.
 *
 * Walks each scope element (and each extra-selector match) depth-first and
 * slices page text into "pieces": a piece is a contiguous run of text nodes
 * delimited by block boundaries, `<br>`, and excluded subtrees. Every piece is
 * rooted at its nearest block-level container (`el`) and anchored at its last
 * text node (`anchor`), which is where Task 5 will insert the block-level
 * translation. The page's own text nodes are never mutated; apart from the
 * `data-ilmt-p` marker attribute, everything here is read-only.
 *
 * Collected anchors are cached so a later dynamic scan does not re-detect (or
 * re-queue) pieces it has already handled — including pieces skipped for being
 * too short or already in the target language, which are cached under `id: ""`.
 */

import { getSiteRule, type SiteRule } from "./site-rules";

/** One translatable piece of a block container. */
export interface ParagraphNode {
  id: string;
  el: Element;
  anchor: Node;
  text: string;
  heading: boolean;
}

/** A detector verdict: the language and its normalized share (0–1). */
export interface LanguageDetection {
  language: string;
  percentage: number;
}

/**
 * Detector result. A bare string is accepted as full confidence so older
 * callers/tests keep working; main wiring returns `{ language, percentage }`.
 */
export type LanguageDetectorResult = string | LanguageDetection | null;

interface CollectOptions {
  /** Minimum trimmed text length; shorter candidates are skipped. */
  minLength?: number;
  /** Minimum target-language share (0–1) required before skipping. */
  langSkipRatio?: number;
  /** Optional language detector; a `null` result falls back to the CJK heuristic. */
  detectLang?: (text: string) => Promise<LanguageDetectorResult>;
  /** BCP-47 target language used by the language-skip rule. */
  targetLang?: string;
  /** Page URL used to resolve the site rule (defaults to the document URL). */
  url?: string;
}

/** Block-level tags used as a fallback when layout provides no `display`. */
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
/** Per-piece source cap. */
const MAX_SOURCE_LENGTH = 20_000;
/** C0 control characters; stripped from the text we send. */
const CONTROL_CHARS = /[\u0000-\u001f]/g;

/** Anchor → cached piece (a real id, or `""` for skipped pieces). */
const anchorCache = new Map<Node, { id: string; text: string }>();
/** Module-global so ids never repeat across scans in one content script. */
let paragraphIdCounter = 0;

/** Precompiled selector strings derived from a site rule. */
interface RuleMatchers {
  allExcludes: string;
  contentExcludes: string;
  extraInline: string;
  extraBlock: string;
}

/** A raw piece before id assignment / cache / language-skip decisions. */
interface RawPiece {
  root: Element;
  anchor: Node;
  text: string;
  heading: boolean;
}

interface WalkContext {
  root: Element;
  heading: boolean;
  parts: string[];
  lastText: Node | null;
}

export function resetPieceCache(): void {
  anchorCache.clear();
}

export function forgetPiece(anchor: Node): void {
  anchorCache.delete(anchor);
}

export function forgetPiecesInRoot(root: ParentNode): void {
  for (const anchor of anchorCache.keys()) {
    if (root.contains(anchor)) anchorCache.delete(anchor);
  }
}

/** Remove one id from a root's `data-ilmt-p` list; drop the attribute when empty. */
export function unmarkPiece(root: Element, id: string): void {
  const next = (root.getAttribute("data-ilmt-p") ?? "").split(/\s+/).filter((x) => x && x !== id);
  if (next.length === 0) root.removeAttribute("data-ilmt-p");
  else root.setAttribute("data-ilmt-p", next.join(" "));
}

/** Append one id to a root's `data-ilmt-p` list without duplicates. */
function markPiece(root: Element, id: string): void {
  const current = (root.getAttribute("data-ilmt-p") ?? "").split(/\s+/).filter(Boolean);
  if (!current.includes(id)) current.push(id);
  root.setAttribute("data-ilmt-p", current.join(" "));
}

/**
 * The nearest block boundary above `node`, using the same logic as the walker,
 * so a flex row's text resolves to the flex row and a heading's text resolves
 * to the heading.
 */
export function pieceRootFor(node: Node, rule: SiteRule): Element | null {
  const matchers = compileRule(rule);
  let el = node.parentElement;
  while (el) {
    if (isBlockBoundary(el, matchers)) return el;
    el = el.parentElement;
  }
  return null;
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
    url,
  } = opts;

  const rule = getSiteRule(url ?? document.location.href);
  if (rule.disabled) return [];

  const matchers = compileRule(rule);

  const scanRoot = root instanceof Document ? (root.body ?? root.documentElement) : root;
  if (!scanRoot) return [];

  const rawPieces: RawPiece[] = [];

  for (const scopeEl of collectScopeElements(scanRoot, rule.scopeSelectors.join(","))) {
    walkScope(scopeEl, matchers, rawPieces);
  }

  // Extra selectors are queried under the scan root (not inside each scope).
  // The ancestor check uses only the content exclusions so a whole skipped
  // sidebar can still contribute a precise paragraph (GitHub About summary).
  const extraSelector = rule.extraTextSelectors.join(",");
  if (extraSelector) {
    for (const match of querySelectorAllSafe(scanRoot, extraSelector)) {
      if (closestSafe(match, matchers.contentExcludes)) continue;
      walkScope(match, matchers, rawPieces);
    }
  }

  const nodes: ParagraphNode[] = [];
  const seen = new Set<Node>();

  for (const piece of rawPieces) {
    if (anchorCache.has(piece.anchor) || seen.has(piece.anchor)) continue;
    seen.add(piece.anchor);

    if (piece.text.length < minLength) {
      anchorCache.set(piece.anchor, { id: "", text: piece.text });
      continue;
    }
    if (await isAlreadyTargetLang(piece.text, detectLang, langSkipRatio, targetLang)) {
      anchorCache.set(piece.anchor, { id: "", text: piece.text });
      continue;
    }

    const id = `p_${++paragraphIdCounter}`;
    anchorCache.set(piece.anchor, { id, text: piece.text });
    markPiece(piece.root, id);
    nodes.push({
      id,
      el: piece.root,
      anchor: piece.anchor,
      text: piece.text,
      heading: piece.heading,
    });
  }

  // Drop cache entries whose anchor left the document (SPA node removal).
  for (const anchor of anchorCache.keys()) {
    if (!anchor.isConnected) anchorCache.delete(anchor);
  }

  return nodes;
}

/** Walk a scope or extra-selector element as a piece root. */
function walkScope(scopeEl: Element, matchers: RuleMatchers, pieces: RawPiece[]): void {
  const ctx: WalkContext = {
    root: scopeEl,
    heading: isHeading(scopeEl),
    parts: [],
    lastText: null,
  };
  for (const child of scopeEl.childNodes) {
    walkNode(child, ctx, matchers, pieces);
  }
  flush(ctx, pieces);
}

function walkNode(
  node: Node,
  ctx: WalkContext,
  matchers: RuleMatchers,
  pieces: RawPiece[],
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.textContent ?? "";
    if (raw.trim().length > 0) {
      ctx.parts.push(raw);
      ctx.lastText = node;
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;

  if (shouldSkip(el, matchers.allExcludes)) {
    if (isBlockBoundary(el, matchers)) flush(ctx, pieces);
    return;
  }
  if (el.tagName === "BR") {
    flush(ctx, pieces);
    return;
  }
  if (isBlockBoundary(el, matchers)) {
    flush(ctx, pieces);
    const childCtx: WalkContext = {
      root: el,
      heading: ctx.heading || isHeading(el),
      parts: [],
      lastText: null,
    };
    for (const child of el.childNodes) walkNode(child, childCtx, matchers, pieces);
    flush(childCtx, pieces);
    return;
  }
  // Inline element: recurse into the same context.
  for (const child of el.childNodes) walkNode(child, ctx, matchers, pieces);
}

function flush(ctx: WalkContext, pieces: RawPiece[]): void {
  if (ctx.lastText === null) return;
  const anchor = ctx.lastText;
  const text = normalizeText(joinTextParts(ctx.parts));
  ctx.parts = [];
  ctx.lastText = null;
  if (text.length === 0) return;
  pieces.push({ root: ctx.root, anchor, text, heading: ctx.heading });
}

/** Collect all scope elements under `scanRoot`, falling back to the root itself. */
function collectScopeElements(scanRoot: ParentNode, scopeSelector: string): Element[] {
  const scopes: Element[] = [];
  if (scanRoot instanceof Element && matchesSelector(scanRoot, scopeSelector)) {
    scopes.push(scanRoot);
  }
  for (const el of querySelectorAllSafe(scanRoot, scopeSelector)) {
    if (!scopes.includes(el)) scopes.push(el);
  }
  if (scopes.length === 0) {
    if (scanRoot instanceof Element) scopes.push(scanRoot);
    else for (const child of scanRoot.children) scopes.push(child);
  }
  return scopes;
}

function compileRule(rule: SiteRule): RuleMatchers {
  return {
    allExcludes: [...rule.excludeSelectors, ...(rule.scopeExcludeSelectors ?? [])].join(","),
    contentExcludes: rule.excludeSelectors.join(","),
    extraInline: (rule.extraInlineSelectors ?? []).join(","),
    extraBlock: (rule.extraBlockSelectors ?? []).join(","),
  };
}

function shouldSkip(el: Element, allExcludes: string): boolean {
  if (matchesSelector(el, allExcludes)) return true;
  const style = computedStyle(el);
  if (style) {
    if (style.display === "none") return true;
    if (style.visibility === "hidden") return true;
  }
  if (el.shadowRoot) return true;
  if (el.classList.contains("ilmt-tr")) return true;
  return false;
}

/**
 * Whether `el` starts a new piece. Headings always do (even inside flex/grid
 * rows). A flex/grid direct item with no block child is treated as inline so a
 * whole row collapses into one piece.
 */
function isBlockBoundary(el: Element, matchers: RuleMatchers): boolean {
  if (isHeading(el)) return true;

  const parentDisplay = displayOf(el.parentElement);
  if (
    (parentDisplay.includes("flex") || parentDisplay.includes("grid")) &&
    !hasBlockChild(el, matchers)
  ) {
    return false;
  }
  return isBlockDisplay(el, matchers);
}

function isBlockDisplay(el: Element, matchers: RuleMatchers): boolean {
  if (matchesSelector(el, matchers.extraInline)) return false;
  if (matchesSelector(el, matchers.extraBlock)) return true;
  const display = displayOf(el);
  if (!display) return BLOCK_TAGS.has(el.tagName.toLowerCase());
  if (display === "none") return false;
  return !isInlineDisplay(display);
}

function hasBlockChild(el: Element, matchers: RuleMatchers): boolean {
  for (const child of el.children) {
    if (child.tagName === "BR") return true;
    if (isBlockDisplay(child, matchers)) return true;
  }
  return false;
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

function isHeading(el: Element): boolean {
  return /^h[1-6]$/i.test(el.tagName) || el.getAttribute("role") === "heading";
}

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

function computedStyle(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument?.defaultView;
  return view ? view.getComputedStyle(el) : null;
}

function matchesSelector(el: Element, selector: string): boolean {
  if (!selector) return false;
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function closestSafe(el: Element, selector: string): Element | null {
  if (!selector) return null;
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

function querySelectorAllSafe(root: ParentNode, selector: string): Element[] {
  if (!selector) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** Join text parts, adding one ASCII space only between two alphanumeric ends. */
function joinTextParts(parts: string[]): string {
  let result = "";
  for (const part of parts) {
    if (result.length === 0) {
      result = part;
      continue;
    }
    if (isAlnum(result[result.length - 1]) && isAlnum(part[0])) result += " ";
    result += part;
  }
  return result;
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function normalizeText(text: string): string {
  return text
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SOURCE_LENGTH);
}

async function isAlreadyTargetLang(
  text: string,
  detectLang: CollectOptions["detectLang"],
  langSkipRatio: number,
  targetLang: string,
): Promise<boolean> {
  if (detectLang) {
    let detected: LanguageDetectorResult = null;
    try {
      detected = await detectLang(text);
    } catch {
      detected = null;
    }
    if (detected) {
      // A bare string keeps the legacy "full confidence" contract.
      const language = typeof detected === "string" ? detected : detected.language;
      const percentage = typeof detected === "string" ? 1 : detected.percentage;
      const matches = languagePrefix(language) === languagePrefix(targetLang);
      return matches && percentage >= langSkipRatio;
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
