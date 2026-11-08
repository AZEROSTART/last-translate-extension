# Text-Node Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace element-level paragraph detection with text-node-level pieces, render every translation as a block that never enters a button, and apply the approved “weakened translation + thin left line” visual style on GitHub and generic article pages.

**Architecture:** A site-rule module chooses the scan scope and exclusions. The collector walks block containers, groups contiguous text nodes into pieces, caches processed anchors, and marks the piece root. The registry stores the root, anchor, and heading flag. The renderer inserts a block after the last safe inline anchor; flex rows insert after the root, headings stay inside, and buttons are never containers. The main bundle wires invalidation, pruning, restore, and the renderer together.

**Tech Stack:** TypeScript, Vite, Chrome MV3 content scripts, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-08-text-node-translation-design.md` (approved; source of truth for algorithms and exact values).

---

## Global Constraints

- All user-visible UI copy stays Chinese. This round changes page translation only.
- API keys stay in the background/storage. No remote code, no inline scripts, no `eval`.
- Never modify an original page text node. Translations are new `.ilmt-tr` nodes.
- Never place a translation inside a `button`, `[role='button']`, `summary`, `label`, `select`, `input`, or other excluded interactive element.
- Translations are always block-level; the old `.ilmt-inline` concept is removed.
- GitHub scope: main content plus repo descriptions (home left repo list and repo-page About). Top navigation, other right-sidebar UI (Releases/Packages/Contributors), footer, and buttons stay English.
- Generic scope: `main`, `article`, `[role='main']`.
- Run `npm test`, `npx tsc --noEmit`, and `npm run build` before claiming completion.
- Commit after each task. Keep the whole test suite green after each commit.

---

## Review Focus

These are the inputs most likely to bite. Each has a test in the task that owns the behavior.

1. **Inline `<code>` in prose.** The code text is omitted from the request, but the surrounding prose must remain one piece. Covered by Task 2.
2. **A `<br>` inside a flex item.** It must produce two pieces rooted at the item, not one piece rooted at the flex row. Covered by Task 2.
3. **A flex row inside a table cell.** The translation stays inside the `td`, never between table rows. Covered by Task 5.
4. **A skipped piece that later grows.** A short “Loading” / “abc” piece is cached as skipped; when the text becomes a full sentence, the cache is forgotten and the new text is queued. Covered by Task 2 and Task 3.
5. **An anchor replaced while its root and old translation remain.** The old translation is pruned and the new anchor is queued. Covered by Task 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/content/site-rules.ts` (new) | Static scope, exclusion, and extra-selector rules for generic pages and GitHub. |
| `src/content/paragraphs.ts` | Text-node walk, block-boundary detection, normalization, text filters, anchor cache, marks, `pieceRootFor`. |
| `src/content/render.ts` | Block insertion at the safe anchor; flex/grid/heading placement; update and restore. |
| `src/content/registry.ts` | Per-piece record with root, anchor, heading, source, status, translation. |
| `src/content/main.ts` | Scan/pump wiring, invalidation, cache resets, prune/orphan cleanup, renderer calls. |
| `src/styles/inject.css` | Style A block rendering, heading style, flex/grid break classes. |
| `tests/unit/site-rules.test.ts` (new) | Rule selection and GitHub disabled paths. |
| `tests/unit/paragraphs.test.ts` (rewrite) | Piece semantics, scope, skips, cache, language skip, marks, normalization. |
| `tests/unit/paragraphs-filter.test.ts` (new) | URL/email/path/handle/hash/version/date/SHA/file-name filters. |
| `tests/unit/render.test.ts` (rewrite) | Block/flex/grid/heading/table insertion, button safety, update, restore. |
| `tests/unit/registry.test.ts` | Anchor/heading storage and anchor-aware prune. |
| `tests/unit/main-ui.test.ts` | Character-data invalidation, skipped-piece growth, orphan pruning. |
| `tests/unit/build.test.ts` | CSS classes ship in `dist/inject.css`. |

---

### Task 1: Site Rules

**Files**
- Create: `src/content/site-rules.ts`
- Create: `tests/unit/site-rules.test.ts`

**Interfaces**
- Consumes: nothing.
- Produces:
  ```ts
  export interface SiteRule {
    id: "generic" | "github";
    disabled?: boolean;
    scopeSelectors: string[];
    extraTextSelectors: string[];
    excludeSelectors: string[];
    scopeExcludeSelectors?: string[];
    extraInlineSelectors?: string[];
    extraBlockSelectors?: string[];
  }
  export function getSiteRule(url: string): SiteRule;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/site-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getSiteRule } from "../../src/content/site-rules";

describe("getSiteRule", () => {
  it("uses the GitHub rule for repository pages", () => {
    const rule = getSiteRule("https://github.com/owner/repo");
    expect(rule.id).toBe("github");
    expect(rule.disabled).not.toBe(true);
    expect(rule.scopeSelectors).toContain("main");
    expect(rule.scopeExcludeSelectors).toContain(".Layout-sidebar");
    expect(rule.extraTextSelectors).toContain(
      ".Layout-sidebar .BorderGrid-row:first-child .BorderGrid-cell > p",
    );
  });

  it("falls back to the generic rule for other sites", () => {
    const rule = getSiteRule("https://example.com/article");
    expect(rule.id).toBe("generic");
    expect(rule.scopeSelectors).toEqual(["main", "article", "[role='main']"]);
    expect(rule.scopeExcludeSelectors ?? []).toHaveLength(0);
  });

  it("disables GitHub settings pages", () => {
    expect(getSiteRule("https://github.com/settings/profile").disabled).toBe(true);
    expect(getSiteRule("https://github.com/owner/repo/settings").disabled).toBe(true);
  });

  it("does not apply the GitHub rule to gists or enterprise hosts", () => {
    expect(getSiteRule("https://gist.github.com/owner/abc").id).toBe("generic");
    expect(getSiteRule("https://github.example.com/owner/repo").id).toBe("generic");
  });

  it("falls back to generic for an unparseable URL", () => {
    expect(getSiteRule("not a url").id).toBe("generic");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/site-rules.test.ts`
Expected: fail because `../../src/content/site-rules` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/content/site-rules.ts` with:

```ts
export interface SiteRule { /* fields above */ }

const BASE: string[] = [ /* §6.2 list exactly */ ];
const GENERIC_COMMON: string[] = [ /* nav, footer, roles in §6.3 */ ];

const GENERIC_RULE: SiteRule = {
  id: "generic",
  scopeSelectors: ["main", "article", "[role='main']"],
  extraTextSelectors: [],
  excludeSelectors: [...BASE, ...GENERIC_COMMON],
};

const GITHUB_RULE: SiteRule = {
  id: "github",
  scopeSelectors: ["main", "#repo-content-turbo-frame", "article", "feed-container"],
  scopeExcludeSelectors: [".Layout-sidebar"],
  extraTextSelectors: [ /* the 12 selectors in §6.4 */ ],
  excludeSelectors: [ /* BASE + GENERIC_COMMON + the GitHub-only selectors in §6.4 */ ],
};

const DISABLED_PREFIXES = [
  "/settings", "/login", "/signup", "/join", "/marketplace", "/pricing",
  "/features", "/sponsors", "/codespaces", "/collections", "/readme", "/site",
  "/about", "/contact", "/security",
];

export function getSiteRule(url: string): SiteRule {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return GENERIC_RULE;
    if (isDisabledGithubPath(parsed.pathname)) {
      return { ...GITHUB_RULE, disabled: true };
    }
    return GITHUB_RULE;
  } catch {
    return GENERIC_RULE;
  }
}

function isDisabledGithubPath(pathname: string): boolean {
  if (DISABLED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  // Repo settings live at /owner/repo/settings, not /settings.
  return pathname.split("/").includes("settings");
}
```

Use the exact selector strings from spec §6.2–§6.4. Do not invent extra selectors. Keep `extraInlineSelectors` / `extraBlockSelectors` absent (empty this round).

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/site-rules.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Run the type check and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/content/site-rules.ts tests/unit/site-rules.test.ts
git commit -m "feat: add site translation rules"
```

---

### Task 2: Text-Node Collector, Cache, and Invalidation

This is the core change. It deliberately combines the collector, anchor cache, language skip, and main-bundle invalidation because the existing dynamic/SPA tests need the cache and the cache needs its invalidation points in the same commit.

**Files**
- Rewrite: `src/content/paragraphs.ts`
- Modify: `src/content/main.ts`
- Rewrite: `tests/unit/paragraphs.test.ts`
- Modify: `tests/unit/registry.test.ts` (helper only; the record does not store the new fields until Task 4)
- Modify: `tests/unit/main-ui.test.ts` (replace the last character-data test with two stronger tests)

**Interfaces**
- Consumes: `SiteRule`, `getSiteRule` from Task 1.
- Produces:
  ```ts
  export interface ParagraphNode {
    id: string;
    el: Element;
    anchor: Node;
    text: string;
    heading: boolean;
  }

  interface CollectOptions {
    minLength?: number;
    langSkipRatio?: number;
    detectLang?: (text: string) => Promise<LanguageDetectorResult>;
    targetLang?: string;
    url?: string;
  }

  export function collectParagraphs(
    root: ParentNode,
    opts?: CollectOptions,
  ): Promise<ParagraphNode[]>;

  export function resetPieceCache(): void;
  export function forgetPiece(anchor: Node): void;
  export function forgetPiecesInRoot(root: ParentNode): void;
  export function unmarkPiece(root: Element, id: string): void;
  export function pieceRootFor(node: Node, rule: SiteRule): Element | null;
  ```

- Remove exported `markParagraph`, `isMarked`, and `clearMarks`. They have no remaining callers.
- Keep `LanguageDetection` and `LanguageDetectorResult` as they are.

#### Collector design (follow spec §7 exactly)

- Walk `childNodes` in order from each scope element (and each extra-selector match).
- Text node with non-empty trimmed text → append its raw text to `ctx.parts`, set `ctx.lastText`.
- Element:
  - `shouldSkip(el, rule)` → if `isBlockBoundary(el, rule)` flush; return.
  - `el.tagName === "BR"` → flush; return.
  - `isBlockBoundary(el, rule)` → flush parent context; flush a child context rooted at `el` with `heading: ctx.heading || isHeading(el)`; return.
  - Otherwise recurse with the same context.
- `flush(ctx)`: ignore if no text/anchor; `joinTextParts` → `normalizeText`; ignore if empty; push `{ root, anchor: lastText, text, heading }`; reset `parts`/`lastText`.
- `joinTextParts`: add one ASCII space only when the last character of the accumulated text and the first character of the next part are both `[A-Za-z0-9]`.
- `normalizeText`: strip `[\u0000-\u001f]`, collapse `\s+` to one space, trim, cap at `20_000`.
- `isHeading`: `h1`–`h6` or `role="heading"`.
- `isBlockBoundary`: exactly spec §7.3. Headings first. Flex/grid direct item with no block child → false. Otherwise `isBlockDisplay`.
- `hasBlockChild`: any direct child with `tagName === "BR"` or `isBlockDisplay(child, rule)`.
- `isBlockDisplay`: `extraInlineSelectors` → false; `extraBlockSelectors` → true; computed `display`; empty display falls back to `BLOCK_TAGS`; `none` → false; otherwise `!isInlineDisplay`.
- `isInlineDisplay`: `inline`, `inline-*`, `contents`, `ruby`, `ruby-base`, `ruby-text`, `math`.
- `shouldSkip`: match `[...excludeSelectors, ...(scopeExcludeSelectors ?? [])].join(",")`; computed `display: none` / `visibility: hidden`; `shadowRoot`; own `.ilmt-tr`. Do **not** use `data-ilmt-p` for skipping.
- `BLOCK_TAGS`: copy the existing set from `paragraphs.ts` / `render.ts` (includes `body`, `html`, `td`, `tr`, etc.).

#### Scope and extra selectors (follow spec §6.5)

- If `rule.disabled` is true, return `[]` before walking anything.
- `scanRoot = root instanceof Document ? root.body ?? root.documentElement : root`.
- Collect **all** matches of `rule.scopeSelectors.join(",")` under `scanRoot`, plus `scanRoot` itself if it matches. Deduplicate.
- If no scope matches, use `scanRoot` when it is an Element; otherwise use its element children.
- Walk each scope using the union exclusion set.
- Query `rule.extraTextSelectors.join(",")` under the scan root (not inside each scope). For each match:
  - Skip when `match.closest(rule.excludeSelectors.join(","))` is non-null. This intentionally does **not** check `scopeExcludeSelectors`, so the GitHub About paragraph can be re-included inside `.Layout-sidebar`.
  - Walk the match's subtree with the full exclusion union.
- Deduplicate across scopes and extra matches with a local `Set<Node>` of anchors.

#### Cache and marks (follow spec §8)

- Module state:
  ```ts
  const anchorCache = new Map<Node, { id: string; text: string }>();
  let paragraphIdCounter = 0;
  ```
- At the top of `collectParagraphs`, `compileRule(rule)` once into precomputed selector strings:
  ```ts
  interface RuleMatchers { allExcludes: string; contentExcludes: string; extraInline: string; extraBlock: string; }
  ```
- For each raw piece:
  - If `anchorCache.has(anchor)` or the local `seen` set has the anchor → skip.
  - Skip if `text.length < minLength`; cache the anchor with `{ id: "", text }`; continue.
  - Skip if `isAlreadyTargetLang(...)`; cache with `{ id: "", text }`; continue.
  - Otherwise assign `id = \`p_${++paragraphIdCounter}\``, cache `{ id, text }`, call `markPiece(root, id)`, push the `ParagraphNode`.
- At the end of the scan, delete cache entries whose `anchor.isConnected` is false.
- `markPiece` appends the id to `data-ilmt-p` (space-separated, no duplicates).
- `unmarkPiece` removes only that id; removes the attribute when no ids remain.
- `forgetPiece(anchor)` deletes one cache entry.
- `forgetPiecesInRoot(root)` deletes every cache key contained by `root`.
- `resetPieceCache()` clears the cache.
- `pieceRootFor(node, rule)`: start at the text node's parent (or the element itself) and walk up; return the first element for which `isBlockBoundary(el, rule)` is true.
- Keep the existing `isAlreadyTargetLang`, `languagePrefix`, and `cjkShare` logic unchanged.

#### Main-bundle changes

- Import the new helpers and `getSiteRule`.
- `collectAndQueue` / `enqueueNewParagraphs`: pass `url: document.location.href` to `collectParagraphs`.
- `unmarkNodes`: for each node call `unmarkPiece(node.el, node.id)` and `forgetPiece(node.anchor)`.
- Overflow loop: same two calls for each overflow node.
- `restore()`: after `restoreAll(document.body)`, call `resetPieceCache()`.
- `rescan()`: after `restoreAll(document.body)`, call `resetPieceCache()`.
- Replace `invalidateParagraph` with `invalidatePieceRoot`:
  ```ts
  function invalidatePieceRoot(root: Element): void {
    const ids = (root.getAttribute("data-ilmt-p") ?? "").split(/\s+/).filter(Boolean);
    for (const id of ids) {
      root.ownerDocument.querySelector(`[data-ilmt-for="${id}"]`)?.remove();
      registry.remove(id);
      deltaBuffers.delete(id);
    }
    root.removeAttribute("data-ilmt-p");
    forgetPiecesInRoot(root);
  }
  ```
- `handleMutations` character-data branch:
  ```ts
  const target = mutation.target;
  const el = target instanceof Element ? target : target.parentElement;
  if (el?.closest(".ilmt-tr")) continue;
  const root = pieceRootFor(target, getSiteRule(document.location.href));
  if (!root) continue;
  if (root.hasAttribute("data-ilmt-p")) invalidatePieceRoot(root);
  else forgetPiecesInRoot(root);
  ```
  Keep the existing `relevant` check and 250 ms dynamic scan debounce.
- Do **not** change `handleDelta` / `handleResult` yet; the registry has no anchor until Task 4 and the renderer still has the old signature.

#### Tests

- [ ] **Step 1: Rewrite `tests/unit/paragraphs.test.ts`**

Use this shape and keep every test in spec §12.1:

```ts
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  collectParagraphs,
  pieceRootFor,
  resetPieceCache,
  unmarkPiece,
} from "../../src/content/paragraphs";
import { getSiteRule } from "../../src/content/site-rules";

const html = (s: string) => {
  document.body.innerHTML = s;
  return document.body;
};
const texts = (ps: Array<{ text: string }>) => ps.map((p) => p.text);

beforeEach(() => {
  document.body.innerHTML = "";
  resetPieceCache();
});

it("splits block containers into pieces rooted at the block", async () => {
  const root = html(`<div><p>First paragraph here.</p><p>Second paragraph here.</p></div>`);
  const ps = await collectParagraphs(root);
  expect(texts(ps)).toEqual(["First paragraph here.", "Second paragraph here."]);
  expect(ps.map((p) => p.el.tagName)).toEqual(["P", "P"]);
  expect(ps.every((p) => p.heading === false)).toBe(true);
});

it("keeps nested inline markup in one piece", async () => {
  const root = html(`<p><a href="#"><span><em>Hello world this is nested</em></span></a></p>`);
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].text).toBe("Hello world this is nested");
  expect(ps[0].el.tagName).toBe("P");
  expect(ps[0].anchor.nodeType).toBe(Node.TEXT_NODE);
  expect(ps[0].anchor.textContent).toBe("Hello world this is nested");
});

it("collects the text around a button and skips the button", async () => {
  const root = html(`<p>prefix <button>action</button> suffix</p>`);
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].text).toBe("prefix suffix");
  expect(ps[0].el.tagName).toBe("P");
  expect(ps[0].anchor.textContent).toContain("suffix");
});

it("produces no piece for a button-only block", async () => {
  const root = html(`<p><button>action</button></p>`);
  expect(await collectParagraphs(root)).toHaveLength(0);
});

it("keeps a flex row with inline items as one piece", async () => {
  const root = html(
    `<div id="row" style="display:flex"><span>Some flexible text</span><button>Action</button></div>`,
  );
  const ps = await collectParagraphs(root);
  expect(ps.map((p) => p.text)).toEqual(["Some flexible text"]);
  expect(ps[0].el).toBe(root.querySelector("#row"));
});

it("makes a heading inside a flex row its own heading piece", async () => {
  const root = html(
    `<div style="display:flex"><h1>Repository title</h1><button>Watch</button></div>`,
  );
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].el.tagName).toBe("H1");
  expect(ps[0].heading).toBe(true);
  expect(ps[0].text).toBe("Repository title");
});

it("splits on a br", async () => {
  const root = html(`<p>Hello<br>world</p>`);
  expect((await collectParagraphs(root)).map((p) => p.text)).toEqual(["Hello", "world"]);
});

it("flushes around nested block containers", async () => {
  const root = html(`<div id="outer">Outer start<div id="inner">Nested text</div>Outer end</div>`);
  const ps = await collectParagraphs(root);
  expect(ps.map((p) => p.text)).toEqual(["Outer start", "Nested text", "Outer end"]);
  expect(ps[0].el).toBe(root.querySelector("#outer"));
  expect(ps[1].el).toBe(root.querySelector("#inner"));
  expect(ps[2].el).toBe(root.querySelector("#outer"));
});

it("collects list items and table cells separately", async () => {
  const root = html(
    `<ul><li>First item text</li><li>Second item text</li></ul>` +
      `<table><tbody><tr><td>Cell one text</td><td>Cell two text</td></tr></tbody></table>`,
  );
  expect(texts(await collectParagraphs(root))).toEqual([
    "First item text",
    "Second item text",
    "Cell one text",
    "Cell two text",
  ]);
});

it("skips code, inputs, editable, hidden, sr-only, and time", async () => {
  const root = html(`
    <pre>code block text</pre>
    <p>Inline <code>const x = 1</code> prose stays.</p>
    <p contenteditable="true">editable text</p>
    <p aria-hidden="true">hidden aria text</p>
    <p hidden>hidden attribute text</p>
    <p class="sr-only">screen reader text</p>
    <p><relative-time>2 hours ago</relative-time> Visible time sentence.</p>
    <p>visible paragraph text</p>`);
  expect(texts(await collectParagraphs(root))).toEqual([
    "Inline prose stays.",
    "Visible time sentence.",
    "visible paragraph text",
  ]);
});

it("flags semantic and role headings", async () => {
  const root = html(
    `<h1>Main title text</h1><div role="heading"><span>Role heading text</span></div>`,
  );
  expect((await collectParagraphs(root)).map((p) => p.heading)).toEqual([true, true]);
});

it("prefers main over the rest of the page", async () => {
  html(`<main><p>Inside the main landmark.</p></main><p>Outside the main landmark.</p>`);
  expect(texts(await collectParagraphs(document))).toEqual(["Inside the main landmark."]);
});

it("returns no pieces on a disabled GitHub path", async () => {
  html(`<main><p>Settings page text.</p></main>`);
  const ps = await collectParagraphs(document.body, {
    url: "https://github.com/settings/profile",
  });
  expect(ps).toHaveLength(0);
});

it("skips the GitHub sidebar but re-includes only the About description", async () => {
  html(`
    <main>
      <p>Repository readme paragraph.</p>
      <aside class="Layout-sidebar">
        <div class="BorderGrid-row">
          <div class="BorderGrid-cell"><p>About description text.</p></div>
        </div>
        <div class="BorderGrid-row">
          <div class="BorderGrid-cell"><p>No releases published yet.</p></div>
        </div>
      </aside>
    </main>`);
  const ps = await collectParagraphs(document.body, {
    url: "https://github.com/owner/repo",
  });
  expect(texts(ps)).toEqual([
    "Repository readme paragraph.",
    "About description text.",
  ]);
});

it("collects repo descriptions outside main through the extra selector", async () => {
  html(`
    <main><p>Feed content text.</p></main>
    <aside class="Layout-sidebar">
      <ul><li class="repo-list-item"><p>Repository description text.</p></li></ul>
    </aside>`);
  const ps = await collectParagraphs(document.body, { url: "https://github.com/" });
  expect(texts(ps)).toEqual(["Feed content text.", "Repository description text."]);
});

it("does not apply GitHub extra selectors on generic pages", async () => {
  html(`
    <main><p>Main content text.</p></main>
    <aside class="Layout-sidebar">
      <div class="BorderGrid-row">
        <div class="BorderGrid-cell"><p>Sidebar description text.</p></div>
      </div>
    </aside>`);
  const ps = await collectParagraphs(document.body, { url: "https://example.com/article" });
  expect(texts(ps)).toEqual(["Main content text."]);
});

it("strips C0 control characters without touching page nodes", async () => {
  const paragraph = document.createElement("p");
  paragraph.textContent = "Hello\u0000 \u0001world\u001f text";
  document.body.appendChild(paragraph);
  const ps = await collectParagraphs(document.body);
  expect(ps).toHaveLength(1);
  expect(ps[0].text).toBe("Hello world text");
  expect(paragraph.textContent).toContain("\u0000");
  expect(paragraph.textContent).toContain("\u001f");
});

it("caps each piece at 20,000 characters", async () => {
  const root = html(`<p>${"a".repeat(25_000)}</p>`);
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].text).toHaveLength(20_000);
  expect(root.querySelector("p")!.textContent).toHaveLength(25_000);
});

it("omits inline code from the source text but keeps surrounding prose", async () => {
  const root = html(`<p>Run <code>npm test</code> before committing.</p>`);
  expect(texts(await collectParagraphs(root))).toEqual(["Run before committing."]);
});

it("does not collect whitespace-only text", async () => {
  html(`<p>   </p><p>\n\t</p>`);
  expect(await collectParagraphs(document.body)).toHaveLength(0);
});

it("splits a flex item containing br into pieces rooted at the item", async () => {
  const root = html(
    `<div style="display:flex"><span style="display:block">Line one<br>Line two</span><button>Action</button></div>`,
  );
  const ps = await collectParagraphs(root);
  expect(ps.map((p) => p.text)).toEqual(["Line one", "Line two"]);
  expect(ps.every((p) => p.el.tagName === "SPAN")).toBe(true);
});

it("merges adjacent inline elements into one piece", async () => {
  const root = html(`<div><span>first part</span><span>second part</span></div>`);
  const ps = await collectParagraphs(root);
  expect(ps.map((p) => p.text)).toEqual(["first part second part"]);
  expect(ps[0].el.tagName).toBe("DIV");
});

it("marks shared roots with every piece id", async () => {
  const root = html(`<div id="outer">Outer start<div id="inner">Nested text</div>Outer end</div>`);
  const ps = await collectParagraphs(root);
  const outer = root.querySelector("#outer")!;
  expect(outer.getAttribute("data-ilmt-p")!.split(" ")).toEqual([ps[0].id, ps[2].id]);
  expect(root.querySelector("#inner")!.getAttribute("data-ilmt-p")).toBe(ps[1].id);
});

it("unmarks one id without clearing the others", async () => {
  const root = html(`<div id="outer">Outer start<div id="inner">Nested text</div>Outer end</div>`);
  const ps = await collectParagraphs(root);
  const outer = root.querySelector("#outer")!;
  unmarkPiece(outer, ps[0].id);
  expect(outer.getAttribute("data-ilmt-p")).toBe(ps[2].id);
  unmarkPiece(outer, ps[2].id);
  expect(outer.hasAttribute("data-ilmt-p")).toBe(false);
});

it("finds the same piece roots used by the walker", () => {
  document.body.innerHTML = `<div id="row" style="display:flex"><span>Some text</span><button>Action</button></div>`;
  const spanText = document.querySelector("span")!.firstChild!;
  expect(pieceRootFor(spanText, getSiteRule("https://example.com/"))).toBe(
    document.querySelector("#row"),
  );

  document.body.innerHTML = `<h1>Title text</h1>`;
  const headingText = document.querySelector("h1")!.firstChild!;
  expect(pieceRootFor(headingText, getSiteRule("https://example.com/"))).toBe(
    document.querySelector("h1"),
  );
});

it("skips text shorter than minLength and caches it", async () => {
  const root = html(`<p>abc</p>`);
  const detect = vi.fn(async () => "en");
  expect(await collectParagraphs(root, { minLength: 4, detectLang: detect })).toHaveLength(0);
  expect(await collectParagraphs(root, { minLength: 4, detectLang: detect })).toHaveLength(0);
  expect(detect).not.toHaveBeenCalled();
});

it("skips pieces already in the target language", async () => {
  const root = html(`<p>这是一段中文内容，不需要翻译。</p><p>This is English content.</p>`);
  const detect = async (text: string) => (/[\u4e00-\u9fa5]/.test(text) ? "zh" : "en");
  expect(texts(await collectParagraphs(root, { detectLang: detect }))).toEqual([
    "This is English content.",
  ]);
});

it("caches target-language pieces so a rescan does not re-detect them", async () => {
  const root = html(`<p>这是一段中文内容，不需要翻译。</p>`);
  const detect = vi.fn(async () => "zh");
  expect(await collectParagraphs(root, { detectLang: detect })).toHaveLength(0);
  expect(await collectParagraphs(root, { detectLang: detect })).toHaveLength(0);
  expect(detect).toHaveBeenCalledTimes(1);
});

it("does not collect the same anchor twice", async () => {
  const root = html(`<p>Only one paragraph here.</p>`);
  await collectParagraphs(root);
  expect(await collectParagraphs(root)).toHaveLength(0);
});

it("resetPieceCache allows a full re-collection", async () => {
  const root = html(`<p>Only one paragraph here.</p>`);
  await collectParagraphs(root);
  resetPieceCache();
  expect(await collectParagraphs(root)).toHaveLength(1);
});
```

Also retain the existing language-skip cases (language prefix, percentage threshold, non-Chinese target not using the CJK heuristic) from the old test file, adapted to the piece API.

- [ ] **Step 2: Run the collector tests and confirm they fail**

Run: `npx vitest run tests/unit/paragraphs.test.ts`
Expected: fail because the new collector API and semantics do not exist.

- [ ] **Step 3: Rewrite `paragraphs.ts`**

Implement the interfaces and algorithm above. Keep the file focused: site-rule consumption, walking, normalization, language skip, cache, marks, and `pieceRootFor`. The text-content filters (URL/email/path/etc.) are Task 3; this task only enforces `minLength`, normalization, and language skip.

- [ ] **Step 4: Update the registry test helper**

In `tests/unit/registry.test.ts`, change the helper so the new required fields type-check:

```ts
function add(r: ParagraphRegistry, id: string, el: Element, anchor: Node = el, heading = false) {
  r.add({ id, el, anchor, text: "hello", heading });
}
```

The registry still stores only the old fields in this task; do not add record fields yet beyond what the type requires.

- [ ] **Step 5: Update `main.ts`**

Apply the main-bundle changes listed above. Do not change the renderer calls or registry record shape yet.

- [ ] **Step 6: Update `main-ui.test.ts`**

Replace the existing “drops a stale translation when a paragraph is edited via characterData” test with these two tests:

```ts
it("drops the old translation and re-queues an edited translated piece", async () => {
  document.body.innerHTML = `<p>Original paragraph text.</p>`;
  const { sent, deliver, request } = await startTranslating();
  const id = request.items[0].id;
  deliver({ type: "result", requestId: request.requestId, items: [{ id, text: "译文" }] });
  deliver({ type: "finish", requestId: request.requestId });
  const paragraph = document.querySelector("p")!;
  expect(paragraph.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  paragraph.firstChild!.textContent = "Edited paragraph text.";
  await new Promise((resolve) => setTimeout(resolve, 350));

  expect(paragraph.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items[0].text).toBe("Edited paragraph text.");
});

it("re-collects a skipped short piece after it grows", async () => {
  document.body.innerHTML = `<p>abc</p>`;
  const { runContentMain } = await import("../../src/content/main");
  const { sent, connect } = captureConnectPort();
  (globalThis as any).chrome.runtime.connect = connect;
  runContentMain();
  await (globalThis as any).__ilmtMain.translatePage();
  expect(sent.filter((m) => m.type === "translate")).toHaveLength(0);

  document.querySelector("p")!.firstChild!.textContent = "This text is long enough now.";
  await new Promise((resolve) => setTimeout(resolve, 350));

  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(1);
  expect(translates[0].items[0].text).toBe("This text is long enough now.");
});
```

- [ ] **Step 7: Run the full suite and type check**

Run: `npm test`
Expected: all tests pass. Pay special attention to `main.test.ts` (2000-piece cap, dynamic new paragraph, SPA rescan), `main-ui.test.ts`, and `main-messages.test.ts`.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/content/paragraphs.ts src/content/main.ts tests/unit/paragraphs.test.ts tests/unit/registry.test.ts tests/unit/main-ui.test.ts
git commit -m "feat: collect text-node translation pieces"
```

---

### Task 3: Text Content Filters

**Files**
- Modify: `src/content/paragraphs.ts`
- Create: `tests/unit/paragraphs-filter.test.ts`

**Interfaces**
- Consumes: the collector and cache from Task 2.
- Produces: no new exports; `collectParagraphs` now also rejects untranslatable text.

- [ ] **Step 1: Write the failing filter tests**

Create `tests/unit/paragraphs-filter.test.ts`:

```ts
import { beforeEach, describe, it, expect } from "vitest";
import { collectParagraphs, resetPieceCache } from "../../src/content/paragraphs";

const html = (s: string) => {
  document.body.innerHTML = s;
  return document.body;
};

beforeEach(() => {
  document.body.innerHTML = "";
  resetPieceCache();
});

it("skips URLs, emails, paths, handles, hashes, versions, dates and SHAs", async () => {
  html(`
    <p>https://example.com/a/b</p>
    <p>someone@example.com</p>
    <p>/usr/local/bin</p>
    <p>src/content/main.ts</p>
    <p>@octocat</p>
    <p>#12345</p>
    <p>v1.2.3</p>
    <p>2026-11-08</p>
    <p>deadbeef</p>
    <p>This sentence should be translated.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["This sentence should be translated."]);
});

it("skips bare filenames with common source extensions", async () => {
  html(`<p>main.ts</p><p>styles.css</p><p>README.md</p><p>This filename is prose.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["This filename is prose."]);
});

it("translates prose that merely contains a URL", async () => {
  html(`<p>Read https://example.com/docs for details.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["Read https://example.com/docs for details."]);
});

it("skips text with no Unicode letters", async () => {
  html(`<p>12345 !!! ---</p><p>+++</p><p>Words are here.</p>`);
  const ps = await collectParagraphs(document.body);
  expect(ps.map((p) => p.text)).toEqual(["Words are here."]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/paragraphs-filter.test.ts`
Expected: fail because the untranslatable text is still collected.

- [ ] **Step 3: Implement `isTranslatableText`**

Add to `paragraphs.ts` and call it after the `minLength` check, before language detection:

```ts
function isTranslatableText(text: string, minLength: number): boolean {
  if (text.length < minLength) return false;
  if (!/\p{L}/u.test(text)) return false;

  const compact = text.trim();
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(compact)) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(compact)) return false;
  if (/^(?:[~./]|[A-Za-z]:[\\/])[\w./\\-]*$/.test(compact)) return false;
  if (/^[\w.-]+(?:\/[\w.-]+)+(?:#\d+)?$/.test(compact)) return false;
  if (/^@[\w.-]+$/.test(compact)) return false;
  if (/^#[\w-]+$/.test(compact)) return false;
  if (/^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i.test(compact)) return false;
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(compact)) {
    return false;
  }
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(compact)) return false;
  if (/^[0-9a-f]{7,40}$/i.test(compact)) return false;
  if (
    /^[\w.-]+\.(?:js|ts|tsx|jsx|css|html|json|md|png|jpe?g|gif|svg|go|py|rs|java|c|cpp|h|sh|yml|yaml|toml)$/i.test(
      compact,
    )
  ) {
    return false;
  }
  return true;
}
```

A rejected text still goes into the anchor cache with `id: ""`, so a later text change can retry it via `forgetPiecesInRoot`.

- [ ] **Step 4: Run the new tests and the full suite**

Run: `npx vitest run tests/unit/paragraphs-filter.test.ts tests/unit/paragraphs.test.ts`
Expected: all pass.

Run: `npm test`
Expected: all pass. The existing main-flow fixtures use sentences, not bare URLs or filenames, so they should not be filtered.

- [ ] **Step 5: Commit**

```bash
git add src/content/paragraphs.ts tests/unit/paragraphs-filter.test.ts
git commit -m "feat: filter untranslatable text pieces"
```

---

### Task 4: Registry Anchor and Heading

**Files**
- Modify: `src/content/registry.ts`
- Modify: `tests/unit/registry.test.ts`

**Interfaces**
- Consumes: `ParagraphNode` with `anchor` and `heading` from Task 2.
- Produces:
  ```ts
  export interface ParagraphRecord {
    id: string;
    el: WeakRef<Element>;
    anchor: WeakRef<Node>;
    heading: boolean;
    sourceText: string;
    status: ParagraphStatus;
    translation?: string;
  }
  ```
- `add(p)` stores `anchor: new WeakRef(p.anchor)` and `heading: p.heading`.
- `prune()` removes a record when either the root or the anchor is disconnected.

- [ ] **Step 1: Add failing registry tests**

Append to `tests/unit/registry.test.ts`:

```ts
it("stores the anchor and heading flag", () => {
  const r = new ParagraphRegistry();
  document.body.innerHTML = `<h1>Title</h1>`;
  const h1 = document.querySelector("h1")!;
  r.add({
    id: "p_1",
    el: h1,
    anchor: h1.firstChild!,
    text: "Title",
    heading: true,
  });
  expect(r.get("p_1")!.heading).toBe(true);
  expect(r.get("p_1")!.anchor.deref()).toBe(h1.firstChild!);
});

it("prunes when the anchor leaves even though the root stays", () => {
  const r = new ParagraphRegistry();
  document.body.innerHTML = `<p>hello</p>`;
  const p = document.querySelector("p")!;
  const anchor = p.firstChild!;
  r.add({ id: "p_1", el: p, anchor, text: "hello", heading: false });
  anchor.parentNode!.removeChild(anchor);
  expect(r.prune()).toBe(1);
  expect(r.get("p_1")).toBeUndefined();
});
```

- [ ] **Step 2: Run the registry tests and confirm the new ones fail**

Run: `npx vitest run tests/unit/registry.test.ts`
Expected: the storage assertion fails because the record has no `anchor`/`heading`; the anchor-prune test fails because only the root is checked.

- [ ] **Step 3: Update the registry**

Add the fields and update `add`/`prune` exactly as above.

- [ ] **Step 4: Run the registry tests and the full suite**

Run: `npx vitest run tests/unit/registry.test.ts`
Expected: all pass.

Run: `npm test`
Expected: all pass. Main still uses `rec.el` only, so this task is behavior-neutral.

- [ ] **Step 5: Commit**

```bash
git add src/content/registry.ts tests/unit/registry.test.ts
git commit -m "feat: track piece anchors and headings in registry"
```

---

### Task 5: Block Renderer and Rendering Wiring

**Files**
- Rewrite: `src/content/render.ts`
- Modify: `src/content/main.ts`
- Rewrite: `tests/unit/render.test.ts`
- Modify: `tests/unit/main-ui.test.ts`

**Interfaces**
- Consumes: `ParagraphRecord` with `anchor`/`heading` from Task 4.
- Produces:
  ```ts
  export interface TranslationTarget {
    root: Element;
    anchor: Node;
    heading?: boolean;
  }

  export function renderTranslation(
    target: TranslationTarget,
    id: string,
    text: string,
    targetLang?: string,
  ): HTMLElement;
  ```
- Keep `updateTranslation`, `restoreAll`, `extractSourceText`, `setInlineLoader`, `clearInlineLoader` with their current signatures.

#### Renderer rules (follow spec §9)

- Existing `[data-ilmt-for=id]`: update `textContent` and `lang` in place; do not move or duplicate it.
- New node: `<span class="ilmt-tr ilmt-block">`; set `data-ilmt-for`, `lang`, `textContent`; add `data-ilmt-heading="1"` when `target.heading`.
- Compute `afterRoot`:
  ```ts
  const display = displayOf(root);
  const isFlex = display.includes("flex");
  const isRow = isFlex && (flexDirection(root) || "row").startsWith("row");
  const scopeLike = root.matches(
    "body, main, article, [role='main'], #repo-content-turbo-frame, feed-container",
  );
  const canAfter = !root.matches(
    "td, th, tr, tbody, thead, tfoot, table, caption, colgroup, col, option, optgroup, select, textarea",
  );
  const afterRoot = !target.heading && isRow && !scopeLike && canAfter && root.parentElement !== null;
  ```
- `afterRoot`: insert after `root` as a sibling; add `breakClassFor(root.parentElement)`.
- Otherwise: insert inside `root` after the safe anchor:
  ```ts
  let node: Node = target.anchor;
  let parent: Node | null = node.parentNode;
  while (parent && parent !== root) {
    const parentEl = parent as Element;
    if (parentEl.parentNode === root && (isFlexOrGrid(root))) {
      node = parentEl;
      parent = parentEl.parentNode;
      continue;
    }
    if (isBlockDisplay(parentEl)) break;
    node = parentEl;
    parent = parentEl.parentNode;
  }
  let ref = node.nextSibling;
  while (ref && isSkippedInline(ref)) ref = ref.nextSibling;
  if (parent) parent.insertBefore(translation, ref);
  else root.appendChild(translation);
  ```
  Add `breakClassFor(root)` for the internal insertion.
- `isSkippedInline(node)`:
  - whitespace-only text node → true;
  - element matching the base skip set and not block-display → true;
  - `.ilmt-tr` → true;
  - otherwise false.
  Use a local `RENDER_SKIP_SELECTOR` string containing the base skip selectors: `button`, `[role='button']`, `summary`, `label`, `select`, `input`, `textarea`, `time`, `relative-time`, `[datetime]`, `[contenteditable]`, `[aria-hidden='true']`, `[hidden]`, `.sr-only`, `.visually-hidden`, `[translate='no']`, `.notranslate`, `.ilmt-tr`. Do not read site rules here; inserting before a site-specific skipped inline element is still safe. The critical assertion is `button.contains(translation) === false`.
- If `target.anchor` is disconnected, append to `root` when the root is connected; otherwise return the node without inserting.
- `breakClassFor`:
  ```ts
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
  ```
- Remove the old `ilmt-inline` branch entirely.
- Keep `BLOCK_TAGS`, `displayOf`, `flexDirection`, and `isBlockDisplay` local to the renderer; this module does not need site-specific display overrides this round.

#### Main-bundle changes

- `handleDelta`:
  ```ts
  const rec = registry.get(msg.id);
  const root = rec?.el.deref();
  const anchor = rec?.anchor.deref();
  if (!rec || !root || !anchor) return;
  const buffered = (deltaBuffers.get(msg.id) ?? "") + msg.text;
  deltaBuffers.set(msg.id, buffered);
  renderTranslation({ root, anchor, heading: rec.heading }, msg.id, buffered, targetLang);
  ```
- `handleResult`: resolve `root`/`anchor` from the record; if both exist, call `renderTranslation({ root, anchor, heading: rec.heading }, item.id, item.text, targetLang)`; keep the status/translation bookkeeping even when the DOM is gone.
- Add:
  ```ts
  function pruneOrphanTranslations(): void {
    const live = new Set(registry.all().map((record) => record.id));
    for (const node of document.querySelectorAll(".ilmt-tr[data-ilmt-for]")) {
      const id = node.getAttribute("data-ilmt-for");
      if (!id || !live.has(id)) node.remove();
    }
  }
  ```
- `pump()`: after `registry.prune()` call `pruneOrphanTranslations()`.
- Prune timer callback: after `registry.prune()` call `pruneOrphanTranslations()`.

#### Tests

- [ ] **Step 1: Rewrite `tests/unit/render.test.ts`**

Use `TranslationTarget` directly:

```ts
import { it, expect, beforeEach } from "vitest";
import {
  renderTranslation,
  updateTranslation,
  restoreAll,
  extractSourceText,
} from "../../src/content/render";

beforeEach(() => {
  document.body.innerHTML = "";
});

it("inserts a block translation after the source text inside a paragraph", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_1", "你好");
  expect(node.classList.contains("ilmt-block")).toBe(true);
  expect(node.classList.contains("ilmt-inline")).toBe(false);
  expect(p.lastElementChild).toBe(node);
});

it("inserts after an inline link, not inside it", () => {
  document.body.innerHTML = `<p><a href="#">Hello</a></p>`;
  const p = document.querySelector("p")!;
  const a = document.querySelector("a")!;
  const node = renderTranslation({ root: p, anchor: a.firstChild! }, "p_2", "你好");
  expect(a.contains(node)).toBe(false);
  expect(a.nextSibling).toBe(node);
});

it("never inserts inside a trailing button", () => {
  document.body.innerHTML = `<p>prefix <button>action</button></p>`;
  const p = document.querySelector("p")!;
  const button = document.querySelector("button")!;
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_3", "前缀");
  expect(button.contains(node)).toBe(false);
  expect(p.lastElementChild).toBe(node);
});

it("uses the target language passed by the caller", () => {
  document.body.innerHTML = `<p>Hello</p>`;
  const p = document.querySelector("p")!;
  const node = renderTranslation({ root: p, anchor: p.firstChild! }, "p_4", "Hello", "ja");
  expect(node.getAttribute("lang")).toBe("ja");
});

it("updates in place, including a translation outside the root", () => {
  document.body.innerHTML = `<div id="row" style="display:flex"><span>Hello</span><button>Action</button></div>`;
  const row = document.querySelector("#row")!;
  renderTranslation({ root: row, anchor: row.querySelector("span")!.firstChild! }, "p_5", "你");
  updateTranslation("p_5", "你好");
  expect(document.querySelectorAll(".ilmt-tr")).toHaveLength(1);
  expect(document.querySelector(".ilmt-tr")!.textContent).toBe("你好");
});

it("places a row-flex translation after the row", () => {
  document.body.innerHTML = `<div id="row" style="display:flex"><span>Hello</span><button>Action</button></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_6",
    "你好",
  );
  expect(row.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  expect(row.nextElementSibling).toBe(node);
  expect(node.classList.contains("ilmt-flex-break")).toBe(false);
});

it("adds a flex break when the row is a child of a row flex", () => {
  document.body.innerHTML = `<div id="parent" style="display:flex"><div id="row" style="display:flex"><span>Hello</span></div></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_7",
    "你好",
  );
  expect(node.classList.contains("ilmt-flex-break")).toBe(true);
});

it("does not add a flex break inside a column-flex parent", () => {
  document.body.innerHTML = `<div id="parent" style="display:flex;flex-direction:column"><div id="row" style="display:flex"><span>Hello</span></div></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_8",
    "你好",
  );
  expect(node.classList.contains("ilmt-flex-break")).toBe(false);
});

it("adds a grid break when the row is a child of a grid", () => {
  document.body.innerHTML = `<div id="parent" style="display:grid"><div id="row" style="display:flex"><span>Hello</span></div></div>`;
  const row = document.querySelector("#row")!;
  const node = renderTranslation(
    { root: row, anchor: row.querySelector("span")!.firstChild! },
    "p_9",
    "你好",
  );
  expect(node.classList.contains("ilmt-grid-break")).toBe(true);
});

it("inserts inside a column-flex root without a flex break", () => {
  document.body.innerHTML = `<div id="col" style="display:flex;flex-direction:column">Hello</div>`;
  const col = document.querySelector("#col")!;
  const node = renderTranslation({ root: col, anchor: col.firstChild! }, "p_10", "你好");
  expect(col.contains(node)).toBe(true);
  expect(node.classList.contains("ilmt-flex-break")).toBe(false);
});

it("inserts inside a grid root with a grid break", () => {
  document.body.innerHTML = `<div id="grid" style="display:grid">Hello</div>`;
  const grid = document.querySelector("#grid")!;
  const node = renderTranslation({ root: grid, anchor: grid.firstChild! }, "p_11", "你好");
  expect(grid.contains(node)).toBe(true);
  expect(node.classList.contains("ilmt-grid-break")).toBe(true);
});

it("inserts a heading translation inside the heading", () => {
  document.body.innerHTML = `<h1>Repository title</h1>`;
  const h1 = document.querySelector("h1")!;
  const node = renderTranslation(
    { root: h1, anchor: h1.firstChild!, heading: true },
    "p_12",
    "仓库标题",
  );
  expect(h1.contains(node)).toBe(true);
  expect(node.getAttribute("data-ilmt-heading")).toBe("1");
});

it("keeps a heading inside its own flex row and adds a flex break", () => {
  document.body.innerHTML = `<h1 id="title" style="display:flex"><span>Title</span></h1>`;
  const h1 = document.querySelector("#title")!;
  const node = renderTranslation(
    { root: h1, anchor: h1.querySelector("span")!.firstChild!, heading: true },
    "p_13",
    "标题",
  );
  expect(h1.contains(node)).toBe(true);
  expect(node.getAttribute("data-ilmt-heading")).toBe("1");
  expect(node.classList.contains("ilmt-flex-break")).toBe(true);
});

it("inserts a table-cell translation inside the cell, not between rows", () => {
  document.body.innerHTML = `<table><tbody><tr><td style="display:flex"><span>Cell text</span></td></tr></tbody></table>`;
  const td = document.querySelector("td")!;
  const node = renderTranslation(
    { root: td, anchor: td.querySelector("span")!.firstChild! },
    "p_14",
    "单元格",
  );
  expect(td.contains(node)).toBe(true);
  expect(td.parentElement!.tagName).toBe("TR");
});

it("appends to the root when the anchor has been detached", () => {
  document.body.innerHTML = `<p id="root">Hello</p>`;
  const root = document.querySelector("#root")!;
  const anchor = root.firstChild!;
  anchor.parentNode!.removeChild(anchor);
  const node = renderTranslation({ root, anchor }, "p_15", "你好");
  expect(root.lastElementChild).toBe(node);
});

it("restores the DOM exactly", () => {
  document.body.innerHTML = `<p data-ilmt-p="p_16">Hello</p>`;
  const before = document.body.innerHTML;
  const p = document.querySelector("p")!;
  renderTranslation({ root: p, anchor: p.firstChild! }, "p_16", "你好");
  restoreAll(document.body);
  expect(document.body.innerHTML).toBe(before);
});

it("extracts source text without the existing translation", () => {
  document.body.innerHTML = `<p>Hello <span class="ilmt-tr" data-ilmt-for="p_17">你好</span></p>`;
  expect(extractSourceText(document.querySelector("p")!)).toBe("Hello");
});
```

- [ ] **Step 2: Run the render tests and confirm they fail**

Run: `npx vitest run tests/unit/render.test.ts`
Expected: fail because `renderTranslation` still takes `(el, id, text)`.

- [ ] **Step 3: Rewrite `render.ts` and update `main.ts`**

Implement the renderer rules and the main-bundle changes above in the same change so the repo compiles.

- [ ] **Step 4: Add the orphan-translation test to `main-ui.test.ts`**

```ts
it("removes an orphaned translation after its anchor is replaced", async () => {
  document.body.innerHTML = `<p>Original paragraph text.</p>`;
  const { sent, deliver, request } = await startTranslating();
  const id = request.items[0].id;
  deliver({ type: "result", requestId: request.requestId, items: [{ id, text: "译文" }] });
  deliver({ type: "finish", requestId: request.requestId });
  const p = document.querySelector("p")!;
  expect(p.querySelectorAll(".ilmt-tr")).toHaveLength(1);

  const oldText = p.firstChild!;
  p.removeChild(oldText);
  p.insertBefore(document.createTextNode("Replacement paragraph text."), p.firstChild);
  await new Promise((resolve) => setTimeout(resolve, 350));

  expect(p.querySelectorAll(".ilmt-tr")).toHaveLength(0);
  const translates = sent.filter((m) => m.type === "translate");
  expect(translates).toHaveLength(2);
  expect(translates[1].items[0].text).toBe("Replacement paragraph text.");
});
```

- [ ] **Step 5: Run the render and main tests**

Run: `npx vitest run tests/unit/render.test.ts tests/unit/main-ui.test.ts tests/unit/main.test.ts tests/unit/main-messages.test.ts`
Expected: all pass.

Run: `npm test`
Expected: all pass.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/content/render.ts src/content/main.ts tests/unit/render.test.ts tests/unit/main-ui.test.ts
git commit -m "feat: render block translations at safe anchors"
```

---

### Task 6: Style A and Build Assertions

**Files**
- Modify: `src/styles/inject.css`
- Modify: `tests/unit/build.test.ts`

**Interfaces**
- Consumes: classes emitted by Task 5 (`ilmt-block`, `data-ilmt-heading`, `ilmt-flex-break`, `ilmt-grid-break`).
- Produces: no runtime API change.

- [ ] **Step 1: Add the failing build assertion**

Add to `tests/unit/build.test.ts` inside the existing `describe`:

```ts
it("ships style A, heading, and flex/grid break classes", () => {
  const css = readFileSync("dist/inject.css", "utf8");
  expect(css).toContain(".ilmt-block");
  expect(css).toContain('[data-ilmt-heading="1"]');
  expect(css).toContain(".ilmt-flex-break");
  expect(css).toContain(".ilmt-grid-break");
  expect(css).not.toContain(".ilmt-inline");
});
```

- [ ] **Step 2: Run the build test and confirm it fails**

Run: `npx vitest run tests/unit/build.test.ts`
Expected: the new assertion fails because the CSS still has `.ilmt-inline` and lacks the heading/break classes.

- [ ] **Step 3: Replace the top of `src/styles/inject.css`**

Use the exact block from spec §11:

```css
/* 译文基座：继承页面字体和颜色 */
.ilmt-tr {
  font: inherit;
  color: inherit;
}

/* 正文译文：弱化 + 左侧细线 */
.ilmt-block {
  display: block !important;
  margin: 0.28em 0 0.42em !important;
  padding-left: 0.6em !important;
  border-left: 2px solid rgba(89, 99, 110, 0.38) !important;
  border-left-color: color-mix(in srgb, currentColor 28%, transparent);
  opacity: 0.78 !important;
  font-size: 0.92em;
  font-weight: 400;
  line-height: 1.55;
}

/* 标题译文：更小、常规字重 */
.ilmt-block[data-ilmt-heading="1"] {
  font-size: 0.68em;
  font-weight: 400;
  line-height: 1.45;
  margin-top: 0.18em !important;
  margin-bottom: 0.2em !important;
  opacity: 0.74 !important;
}

/* flex 容器内部插入时占满一行 */
.ilmt-flex-break {
  flex: 0 0 100% !important;
  width: 100% !important;
  max-width: 100% !important;
}

/* grid 容器内部插入时横跨所有列 */
.ilmt-grid-break {
  grid-column: 1 / -1 !important;
}

/* 待翻译状态 */
.ilmt-tr[data-loading="1"] {
  opacity: 0.4 !important;
}
```

Delete the old `.ilmt-block` and `.ilmt-inline` rules. Leave the banner, error-banner, and bubble styles unchanged.

- [ ] **Step 4: Run the build test and the full suite**

Run: `npx vitest run tests/unit/build.test.ts`
Expected: pass.

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/styles/inject.css tests/unit/build.test.ts
git commit -m "style: add block translation style A"
```

---

### Task 7: Final Verification and Live GitHub Check

**Files**
- No planned source changes. Fix any failures found here in the owning task, then re-run the verification commands.

- [ ] **Step 1: Run the full verification**

```bash
npm test
npx tsc --noEmit
npm run build
```

Expected: all tests pass, no type errors, build emits `dist/inject.css` and the manifest.

- [ ] **Step 2: Verify the built CSS**

Run: `grep -E "ilmt-(block|flex-break|grid-break|inline)" dist/inject.css`
Expected: block, flex-break, grid-break present; no `.ilmt-inline`.

- [ ] **Step 3: Live GitHub check**

Load the extension in Chrome, refresh a GitHub repository page, and use the native context menu → 「翻译当前页面」 (the native Chrome menu cannot be automated; this step is manual). Check:

- README headings, paragraphs, lists, tables, and quote blocks have translations.
- Issue/PR titles and comment bodies have translations.
- The left repo-list description and the right About description have translations.
- Watch / Fork / Star / Code / Comment buttons contain no translation nodes.
- Releases / Packages / Contributors UI paragraphs stay English.
- Top navigation and footer stay English.
- Heading translations are visibly smaller and normal weight.
- Body translations have a thin left line and are slightly faded.
- Expanding dynamic content or switching SPA routes does not duplicate or strand translations.

If the content script is missing, refresh the tab; tabs opened before an extension reload do not get the content script.

- [ ] **Step 4: Commit any fixes**

If this task needed changes, stage the changed files and commit with a focused message. Otherwise leave the tree clean.

---

## Plan Self-Review

- **Spec coverage:** Site rules (Task 1), text-node pieces and cache (Task 2), text filters (Task 3), registry anchor/heading (Task 4), block renderer and main wiring (Task 5), style A (Task 6), live verification (Task 7).
- **Type consistency:** `ParagraphNode` gains `anchor`/`heading` in Task 2; `ParagraphRecord` gains them in Task 4 before Task 5 reads them. `renderTranslation` changes from `(el, id, text)` to `(target, id, text)` only in Task 5, together with its main callers.
- **Review Focus tests:** inline `<code>` (Task 2), flex `<br>` (Task 2), table-cell flex (Task 5), skipped-piece growth (Task 2 + Task 3), anchor replacement/orphan (Task 5).
- **Green intermediate commits:** Task 2 includes the cache invalidation, restore/rescan resets, and unmark/overflow cleanup; Task 5 changes the renderer signature and main callers in one commit.
