import { describe, it, expect, beforeEach } from "vitest";
import { findSurfaceRange } from "../../src/content/glossary-range";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("findSurfaceRange", () => {
  it("finds a word inside one text node", () => {
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const range = findSurfaceRange([text], "outlive")!;
    expect(range.toString()).toBe("outlive");
  });

  it("is case-insensitive and respects word boundaries", () => {
    document.body.innerHTML = `<p>Article and art.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    expect(findSurfaceRange([text], "art")?.toString()).toBe("art");
    expect(findSurfaceRange([text], "missing")).toBeUndefined();
  });

  it("finds a phrase inside one text node", () => {
    document.body.innerHTML = `<p>We need to look up the word.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    expect(findSurfaceRange([text], "look up")?.toString()).toBe("look up");
  });

  it("skips code, pre, kbd, samp and translation nodes", () => {
    document.body.innerHTML = `<p>Text <code>outlive</code> <span class="ilmt-tr">outlive</span></p>`;
    const p = document.querySelector("p")!;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const nodes: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    // The only "outlive" occurrences are inside <code> and .ilmt-tr.
    expect(findSurfaceRange(nodes, "outlive")).toBeUndefined();
  });

  it("skips a phrase split across text nodes in v1", () => {
    document.body.innerHTML = `<p>look <em>up</em></p>`;
    const p = document.querySelector("p")!;
    const nodes = [p.firstChild!, p.querySelector("em")!.firstChild!];
    expect(findSurfaceRange(nodes, "look up")).toBeUndefined();
  });

  it("finds a CJK surface without ASCII word boundaries", () => {
    document.body.innerHTML = `<p>小工具比制造者存在得更久。</p>`;
    const text = document.querySelector("p")!.firstChild!;
    expect(findSurfaceRange([text], "存在得更久")?.toString()).toBe("存在得更久");
  });

  it("returns undefined for empty surfaces and non-text nodes", () => {
    document.body.innerHTML = `<p>hello</p>`;
    const p = document.querySelector("p")!;
    expect(findSurfaceRange([p], "hello")).toBeUndefined();
    expect(findSurfaceRange([p.firstChild!], "   ")).toBeUndefined();
  });
});
