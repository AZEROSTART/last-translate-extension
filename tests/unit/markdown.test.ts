import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/panel/markdown";

function render(text: string): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(renderMarkdown(text));
  return host;
}

describe("renderMarkdown blocks", () => {
  it("returns an empty fragment for an empty string", () => {
    const fragment = renderMarkdown("");
    expect(fragment.childNodes).toHaveLength(0);
  });

  it("renders a closed fenced code block without inline parsing", () => {
    const host = render("```js\nconst x = **1**;\n```");
    const pre = host.querySelector("pre.md-pre")!;
    expect(pre).not.toBeNull();
    expect(pre.querySelector("code")?.textContent).toBe("const x = **1**;");
    expect(pre.querySelector("strong")).toBeNull();
  });

  it("renders an unclosed fence through end-of-input while streaming", () => {
    const host = render("before\n```\nconst x = 1");
    expect(host.querySelector(".md-p")?.textContent).toBe("before");
    expect(host.querySelector("pre.md-pre")?.textContent).toBe("const x = 1");
    expect(host.textContent).not.toContain("```");
  });

  it("renders headings", () => {
    const host = render("# One\n## Two\n### Three");
    const headings = Array.from(host.querySelectorAll(".md-heading")).map(
      (node) => node.textContent,
    );
    expect(headings).toEqual(["One", "Two", "Three"]);
  });

  it("renders unordered and ordered lists", () => {
    const unordered = render("- one\n- two");
    expect(unordered.querySelectorAll("ul.md-list > li")).toHaveLength(2);
    expect(unordered.querySelectorAll("ul.md-list > li")[1].textContent).toBe("two");

    const ordered = render("1. first\n2. second");
    expect(ordered.querySelectorAll("ol.md-list > li")).toHaveLength(2);
    expect(ordered.querySelectorAll("ol.md-list > li")[0].textContent).toBe("first");
  });

  it("renders a blockquote from consecutive lines", () => {
    const host = render("> first\n> second");
    expect(host.querySelector("blockquote.md-quote")?.textContent).toBe("first\nsecond");
  });

  it("groups consecutive plain lines into one paragraph", () => {
    const host = render("hello\nworld\n\nnext");
    const paragraphs = Array.from(host.querySelectorAll(".md-p")).map(
      (node) => node.textContent,
    );
    expect(paragraphs).toEqual(["hello\nworld", "next"]);
  });
});

describe("renderMarkdown inline", () => {
  it("renders code, bold and italic", () => {
    const host = render("`code` **bold** *italic*");
    expect(host.querySelector("code.md-code")?.textContent).toBe("code");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector("em")?.textContent).toBe("italic");
  });

  it("supports inline code nested in bold", () => {
    const host = render("**bold with `code`**");
    expect(host.querySelector("strong code.md-code")?.textContent).toBe("code");
  });

  it("emits unclosed inline markers literally", () => {
    const host = render("**bold and `code and *ital");
    expect(host.querySelector("strong")).toBeNull();
    expect(host.querySelector("code")).toBeNull();
    expect(host.querySelector("em")).toBeNull();
    expect(host.textContent).toBe("**bold and `code and *ital");
  });

  it("keeps literal HTML inert", () => {
    const host = render(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<svg onload=alert(1)>**",
    );
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg")).toBeNull();
    expect(host.textContent).toContain("<script>alert(1)</script>");
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(host.querySelector("strong")?.textContent).toBe("<svg onload=alert(1)>");
  });
});
