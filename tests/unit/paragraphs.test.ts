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

it("skips notranslate and translate=no subtrees", async () => {
  const root = html(`<div translate="no"><p>Excluded by translate no.</p></div>
    <p class="notranslate">Excluded by the class name.</p><p>Keep this paragraph.</p>`);
  expect(texts(await collectParagraphs(root))).toEqual(["Keep this paragraph."]);
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

it("re-includes the GitHub About description under contentOnly", async () => {
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
    contentOnly: true,
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

it("honors a larger minLength and caches short pieces", async () => {
  const root = html(`<p>short</p><p>This paragraph is long enough.</p>`);
  const detect = vi.fn(async () => "en");
  expect(await collectParagraphs(root, { minLength: 10, detectLang: detect })).toHaveLength(1);
  expect(detect).toHaveBeenCalledTimes(1);
});

it("skips secondary regions when contentOnly is on", async () => {
  const root = html(`
    <main>
      <h1>Article title here</h1>
      <p>This is the main article paragraph.</p>
      <ul><li>This is a list item.</li></ul>
      <table><tr><td>This is a table cell.</td></tr></table>
      <aside><p>This aside should not be translated.</p></aside>
      <small>This small print should not be translated.</small>
      <figcaption>This caption should not be translated.</figcaption>
      <div class="breadcrumb">Home / Docs / Guide</div>
      <div class="post-meta">By someone, published today</div>
    </main>`);

  const ps = await collectParagraphs(root, { contentOnly: true, minLength: 4 });
  expect(texts(ps)).toEqual([
    "Article title here",
    "This is the main article paragraph.",
    "This is a list item.",
    "This is a table cell.",
  ]);
});

it("keeps old behavior when contentOnly is off", async () => {
  const root = html(`
    <main>
      <p>This is the main article paragraph.</p>
      <aside><p>This aside is still translated.</p></aside>
      <figcaption>This caption is still translated.</figcaption>
    </main>`);

  const ps = await collectParagraphs(root, { contentOnly: false });
  expect(texts(ps)).toContain("This aside is still translated.");
  expect(texts(ps)).toContain("This caption is still translated.");
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

describe("target language and CJK fallback", () => {
  it("compares language prefixes against targetLang", async () => {
    const root = html(`<p lang="zh">这是中文文本内容。</p><p lang="en">This is English text.</p>`);
    const ps = await collectParagraphs(root, {
      targetLang: "zh-CN",
      detectLang: async (t) => (t.includes("中文") ? "zh-Hans" : "en"),
    });
    expect(texts(ps)).toEqual(["This is English text."]);
  });

  it("skips only when the target-language share meets the skip ratio", async () => {
    const root = html(`<p>这是一段中英混合的段落内容 with plenty of English.</p>
      <p>这是几乎全中文的段落内容。</p>`);
    const shares: Record<string, number> = {
      "这是一段中英混合的段落内容 with plenty of English.": 0.7,
      "这是几乎全中文的段落内容。": 0.9,
    };

    const ps = await collectParagraphs(root, {
      targetLang: "zh-CN",
      langSkipRatio: 0.8,
      detectLang: async (text) => ({ language: "zh", percentage: shares[text] ?? 1 }),
    });

    expect(texts(ps)).toEqual(["这是一段中英混合的段落内容 with plenty of English."]);
  });

  it("falls back to the CJK heuristic when detection returns null", async () => {
    const root = html(`<p>这是一段完全由中文组成的段落内容</p><p>This is English content.</p>`);
    const ps = await collectParagraphs(root, {
      targetLang: "zh-CN",
      detectLang: async () => null,
    });
    expect(texts(ps)).toEqual(["This is English content."]);
  });

  it("does not apply the CJK heuristic for non-Chinese targets", async () => {
    const root = html(`<p>这是一段完全由中文组成的段落内容</p>`);
    const ps = await collectParagraphs(root, { targetLang: "en" });
    expect(ps).toHaveLength(1);
  });
});

it("records the text nodes that make up a piece", async () => {
  const root = html(`<p>Hello <em>world</em>.</p>`);
  const [piece] = await collectParagraphs(root);
  expect(piece.textNodes?.map((node) => node.textContent)).toEqual(["Hello ", "world", "."]);
});
