import { describe, it, expect, beforeEach } from "vitest";
import { buildSelectionContext } from "../../src/content/selection-context";

function rangeFor(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range;
}

function rangeForText(node: Text, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("buildSelectionContext", () => {
  it("captures the current paragraph, up to two preceding paragraphs, and the nearest heading", () => {
    document.body.innerHTML = `
      <h2>Section title</h2>
      <p>First paragraph.</p>
      <p>Second <strong>selected sentence</strong> continues.</p>
      <p>Third paragraph.</p>
    `;

    const context = buildSelectionContext(rangeFor(document.querySelector("strong")!));

    expect(context).toEqual({
      heading: "Section title",
      paragraph: "Second selected sentence continues.",
      preceding: ["First paragraph."],
    });
  });

  it("strips injected translation nodes from the source text", () => {
    document.body.innerHTML = `<p>Source <span class="ilmt-tr">译文</span> text</p>`;

    const paragraph = document.querySelector("p")!;
    const source = paragraph.firstChild as Text;
    const context = buildSelectionContext(rangeForText(source, 0, source.length));

    expect(context?.paragraph).toBe("Source text");
  });

  it("keeps the selected sentence visible when a long paragraph is truncated around it", () => {
    document.body.innerHTML = `<p></p>`;
    const paragraph = document.querySelector("p")!;
    paragraph.textContent = `${"A".repeat(2000)}TARGET${"B".repeat(2000)}`;
    const text = paragraph.firstChild as Text;

    const context = buildSelectionContext(rangeForText(text, 2000, 2006));

    expect(context?.paragraph).toContain("TARGET");
    expect(context?.paragraph.length).toBeLessThanOrEqual(1002);
    expect(context?.paragraph.startsWith("…")).toBe(true);
    expect(context?.paragraph.endsWith("…")).toBe(true);
  });

  it("returns undefined when the selection is outside a usable block", () => {
    document.body.textContent = "Bare body text";

    expect(buildSelectionContext(rangeFor(document.body))).toBeUndefined();
  });

  it("finds the surrounding paragraph when the selection lives in an inline element", () => {
    document.body.innerHTML = `<p>Alpha <em>beta</em> gamma</p>`;

    const context = buildSelectionContext(rangeFor(document.querySelector("em")!));

    expect(context?.paragraph).toBe("Alpha beta gamma");
  });

  it("orders the two preceding paragraphs from oldest to nearest", () => {
    document.body.innerHTML = `
      <p>One.</p>
      <p>Two.</p>
      <p>Three.</p>
      <p>Current.</p>
    `;

    const context = buildSelectionContext(rangeFor(document.querySelectorAll("p")[3]));

    expect(context?.preceding).toEqual(["Two.", "Three."]);
  });

  it("omits the heading when there is no heading before the paragraph", () => {
    document.body.innerHTML = `<p>First.</p><p>Second.</p>`;

    const context = buildSelectionContext(rangeFor(document.querySelectorAll("p")[1]));

    expect(context?.heading).toBeUndefined();
  });
});
