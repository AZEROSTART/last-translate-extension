import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlossController } from "../../src/content/glossary";

function stubHighlights(): Map<string, unknown> {
  const registry = new Map<string, unknown>();
  vi.stubGlobal(
    "Highlight",
    class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
  );
  vi.stubGlobal("CSS", { highlights: registry });
  return registry;
}

function stubFrame(): void {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
}

function stubCaret(node: Node, offset: number): void {
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    value: vi.fn(() => ({ offsetNode: node, offset })),
  });
}

const RECT = { left: 10, top: 20, width: 60, height: 16, bottom: 36, right: 70 };

function stubRangeRect(rect: DOMRect = RECT as DOMRect): void {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  document.body.innerHTML = "";
});

describe("createGlossController", () => {
  it("adds a CSS highlight and shows a card on hover", () => {
    stubFrame();
    const registry = stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph("p_1", [text], [
      {
        surface: "outlive",
        pos: "v.",
        meaning: "比……存在得更久",
        example: "Small tools often outlive their makers.",
      },
    ]);
    expect(registry.get("ilmt-gloss")).toBeTruthy();

    stubRangeRect();
    stubCaret(text, 20);

    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }),
    );
    vi.advanceTimersByTime(150);

    const card = document.querySelector("[role=tooltip]")!;
    expect(card.textContent).toContain("outlive");
    expect(card.textContent).toContain("v.");
    expect(card.textContent).toContain("比……存在得更久");
    expect(card.textContent).toContain("Small tools often outlive their makers.");
  });

  it("renders model text literally instead of injecting HTML", () => {
    stubFrame();
    stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph("p_1", [text], [
      { surface: "outlive", meaning: "<img src=x onerror=alert(1)>" },
    ]);
    stubRangeRect();
    stubCaret(text, 20);

    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
    vi.advanceTimersByTime(150);

    const card = document.querySelector("[role=tooltip]")!;
    expect(card.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
  });

  it("removes the card when the pointer leaves the annotated word", () => {
    stubFrame();
    stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "更持久" }]);
    stubRangeRect();
    stubCaret(text, 20);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
    vi.advanceTimersByTime(150);
    expect(document.querySelector("[role=tooltip]")).toBeTruthy();

    stubCaret(text, 0);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 28 }));
    expect(document.querySelector("[role=tooltip]")).toBeNull();
  });

  it("removes the card and highlight on stop()", () => {
    stubFrame();
    const registry = stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "更持久" }]);
    stubRangeRect();
    stubCaret(text, 20);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
    vi.advanceTimersByTime(150);
    expect(document.querySelector("[role=tooltip]")).toBeTruthy();

    controller.stop();
    expect(document.querySelector("[role=tooltip]")).toBeNull();
    expect(registry.has("ilmt-gloss")).toBe(false);
  });

  it("degrades quietly without CSS.highlights or Highlight", () => {
    stubFrame();
    vi.stubGlobal("CSS", undefined);
    vi.stubGlobal("Highlight", undefined);
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    expect(() => {
      controller.start();
      controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "更持久" }]);
    }).not.toThrow();
  });

  it("prunes annotations whose paragraph is gone", () => {
    stubFrame();
    const registry = stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "更持久" }]);
    expect(registry.has("ilmt-gloss")).toBe(true);

    controller.prune(new Set());
    expect(registry.has("ilmt-gloss")).toBe(false);
  });

  it("clears a paragraph's highlight when its notes become empty", () => {
    stubFrame();
    const registry = stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "更持久" }]);
    expect(registry.has("ilmt-gloss")).toBe(true);

    controller.setParagraph("p_1", [text], []);
    expect(registry.has("ilmt-gloss")).toBe(false);
  });
});
