import { describe, it, expect } from "vitest";
import {
  collectParagraphs,
  markParagraph,
  isMarked,
  clearMarks,
} from "../../src/content/paragraphs";

const html = (s: string) => { document.body.innerHTML = s; return document.body; };

it("splits block containers into separate paragraphs", async () => {
  const root = html(`<div><p>First paragraph here.</p><p>Second paragraph here.</p></div>`);
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(2);
});

it("treats nested inline markup as one paragraph", async () => {
  const root = html(`<p><a href="#"><span><em>Hello world this is nested</em></span></a></p>`);
  const ps = await collectParagraphs(root);
  expect(ps).toHaveLength(1);
  expect(ps[0].text.trim()).toBe("Hello world this is nested");
});

it("skips code, inputs, editable and hidden content", async () => {
  const root = html(`<pre>code here</pre><p contenteditable="true">editable text</p>
    <p aria-hidden="true">hidden text</p><p>visible paragraph</p>`);
  const ps = await collectParagraphs(root);
  expect(ps.map(p => p.text.trim())).toEqual(["visible paragraph"]);
});

it("skips text shorter than the minimum length", async () => {
  const root = html(`<p>abc</p><p>abcdef</p>`);
  const ps = await collectParagraphs(root, { minLength: 4 });
  expect(ps.map(p => p.text.trim())).toEqual(["abcdef"]);
});

it("skips paragraphs already in the target language", async () => {
  const root = html(`<p>这是一段中文内容，不需要翻译。</p><p>This is English content.</p>`);
  const ps = await collectParagraphs(root, { langSkipRatio: 0.8, detectLang: async t => (/[\u4e00-\u9fa5]/.test(t) ? "zh" : "en") });
  expect(ps.map(p => p.text.trim())).toEqual(["This is English content."]);
});

it("does not collect the same element twice", async () => {
  const root = html(`<p>Only one paragraph here.</p>`);
  await collectParagraphs(root);
  const second = await collectParagraphs(root);
  expect(second).toHaveLength(0);
});

describe("source sanitizing", () => {
  it("strips C0 control characters without touching the page nodes", async () => {
    document.body.innerHTML = "";
    const paragraph = document.createElement("p");
    // Assign the string directly: the HTML parser itself drops U+0000.
    paragraph.textContent = "Hello\u0000 \u0001world\u001f text";
    document.body.appendChild(paragraph);

    const ps = await collectParagraphs(document.body);

    expect(ps).toHaveLength(1);
    expect(ps[0].text).toBe("Hello world text");
    expect(paragraph.textContent).toContain("\u0000");
    expect(paragraph.textContent).toContain("\u001f");
  });

  it("caps each paragraph at 20,000 characters", async () => {
    const root = html(`<p>${"a".repeat(25_000)}</p>`);
    const ps = await collectParagraphs(root);

    expect(ps).toHaveLength(1);
    expect(ps[0].text).toHaveLength(20_000);
    // The DOM is untouched: only the text sent for translation is clamped.
    expect(root.querySelector("p")!.textContent).toHaveLength(25_000);
  });
});

describe("target language and marks", () => {  it("compares language prefixes against targetLang", async () => {
    const root = html(`<p lang="zh">这是中文文本内容。</p><p lang="en">This is English text.</p>`);
    const ps = await collectParagraphs(root, {
      targetLang: "zh-CN",
      detectLang: async t => (t.includes("中文") ? "zh-Hans" : "en"),
    });
    expect(ps.map(p => p.text.trim())).toEqual(["This is English text."]);
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

    // 0.7 is below the ratio, so it is sent; 0.9 is already target language.
    expect(ps.map((p) => p.text.trim())).toEqual([
      "这是一段中英混合的段落内容 with plenty of English.",
    ]);
  });

  it("falls back to the CJK heuristic when detection returns null", async () => {
    const root = html(`<p>这是一段完全由中文组成的段落内容</p><p>This is English content.</p>`);
    const ps = await collectParagraphs(root, {
      targetLang: "zh-CN",
      detectLang: async () => null,
    });
    expect(ps.map(p => p.text.trim())).toEqual(["This is English content."]);
  });

  it("does not apply the CJK heuristic for non-Chinese targets", async () => {
    const root = html(`<p>这是一段完全由中文组成的段落内容</p>`);
    const ps = await collectParagraphs(root, { targetLang: "en" });
    expect(ps).toHaveLength(1);
  });

  it("prefers <main> when scanning the document", async () => {
    html(`<main><p>Inside the main landmark.</p></main><p>Outside the main landmark.</p>`);
    const ps = await collectParagraphs(document);
    expect(ps.map(p => p.text.trim())).toEqual(["Inside the main landmark."]);
  });

  it("skips notranslate and translate=no subtrees", async () => {
    const root = html(`<div translate="no"><p>Excluded by translate no.</p></div>
      <p class="notranslate">Excluded by the class name.</p><p>Keep this paragraph.</p>`);
    const ps = await collectParagraphs(root);
    expect(ps.map(p => p.text.trim())).toEqual(["Keep this paragraph."]);
  });

  it("marks the innermost text-bearing element when a block only wraps inline markup", async () => {
    const root = html(`<p><a href="#">link text</a></p>`);
    const ps = await collectParagraphs(root);
    const p = root.querySelector("p")!;

    expect(ps).toHaveLength(1);
    expect(ps[0].el.tagName).toBe("A");
    expect(ps[0].el.getAttribute("data-ilmt-p")).toBe(ps[0].id);
    expect(p.hasAttribute("data-ilmt-p")).toBe(false);
  });

  it("does not merge sibling inline elements when the block has no direct text child", async () => {
    const root = html(`<div><span>first part</span><span>second part</span></div>`);
    const ps = await collectParagraphs(root);
    expect(ps.map(p => p.text)).toEqual(["first part", "second part"]);
  });

  it("does not collect a block whose element child is atomic-inline", async () => {
    const root = html(`<p>prefix <button>action</button> suffix</p>`);
    const ps = await collectParagraphs(root);

    expect(root.querySelector("p")!.hasAttribute("data-ilmt-p")).toBe(false);
    expect(ps).toHaveLength(1);
    expect(ps[0].el.tagName).toBe("BUTTON");
  });

  it("marks paragraphs and clears marks", async () => {
    const root = html(`<p>Visible paragraph text.</p>`);
    const el = root.querySelector("p")!;
    markParagraph(el, "p_42");

    expect(isMarked(el)).toBe(true);
    expect(el.getAttribute("data-ilmt-p")).toBe("p_42");
    expect(await collectParagraphs(root)).toHaveLength(0);

    clearMarks(root);
    expect(isMarked(el)).toBe(false);
    expect(await collectParagraphs(root)).toHaveLength(1);
  });
});
