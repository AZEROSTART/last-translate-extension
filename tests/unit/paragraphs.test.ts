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

describe("target language and marks", () => {
  it("compares language prefixes against targetLang", async () => {
    const root = html(`<p lang="zh">这是中文文本内容。</p><p lang="en">This is English text.</p>`);
    const ps = await collectParagraphs(root, {
      targetLang: "zh-CN",
      detectLang: async t => (t.includes("中文") ? "zh-Hans" : "en"),
    });
    expect(ps.map(p => p.text.trim())).toEqual(["This is English text."]);
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
