import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlossController, type GlossControllerDeps } from "../../src/content/glossary";
import { getEffect } from "../../src/content/effects";

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

  it("reports how many annotated ranges are currently highlighted", () => {
    stubFrame();
    stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph("p_1", [text], [
      { surface: "outlive", meaning: "比……存在得更久" },
    ]);
    expect(controller.count()).toBe(1);

    controller.removeParagraph("p_1");
    expect(controller.count()).toBe(0);
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
    vi.advanceTimersByTime(180);
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

function openCard(termLang?: string): HTMLElement {
  stubFrame();
  stubHighlights();
  document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
  const text = document.querySelector("p")!.firstChild!;
  const controller = createGlossController(document, {
    resolveEffect: () => getEffect("gopher-hole")!,
  });
  controller.start();
  controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "比……存在得更久" }], termLang);
  stubRangeRect();
  stubCaret(text, 20);
  document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }));
  vi.advanceTimersByTime(150);
  return document.querySelector("[role=tooltip]") as HTMLElement;
}

describe("hover intent", () => {
  it("keeps the card open while the pointer is inside it", () => {
    const card = openCard();
    Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 200, top: 200, right: 400, bottom: 300, width: 200, height: 100, x: 200, y: 200 }),
    });
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 250, clientY: 250 }));
    vi.advanceTimersByTime(300);
    expect(document.querySelector("[role=tooltip]")).toBeTruthy();
  });

  it("hides 180ms after leaving both the word and the card", () => {
    openCard();
    stubCaret(document.querySelector("p")!.firstChild!, 0);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 28 }));
    vi.advanceTimersByTime(179);
    expect(document.querySelector("[role=tooltip]")).toBeTruthy();
    vi.advanceTimersByTime(1);
    expect(document.querySelector("[role=tooltip]")).toBeNull();
  });
});

type SendLearn = NonNullable<GlossControllerDeps["sendLearn"]>;

const EFFECT_BUTTON = '[role=tooltip] [data-ilmt-effect="gopher-hole"] button';

/** Hover the annotated word with the gopher pinned, so the state is deterministic. */
function openClaimCard(sendLearn: SendLearn): void {
  stubFrame();
  stubHighlights();
  document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
  const text = document.querySelector("p")!.firstChild!;
  const controller = createGlossController(document, {
    sendLearn,
    resolveEffect: () => getEffect("gopher-hole")!,
  });
  controller.start();
  controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "比……存在得更久" }], "en");
  stubRangeRect();
  stubCaret(text, 20);
  document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
  vi.advanceTimersByTime(150);
}

function clickEffect(): void {
  document.querySelector<HTMLButtonElement>(EFFECT_BUTTON)!.click();
}

function effectState(): string | undefined {
  return document.querySelector<HTMLElement>('[data-ilmt-effect="gopher-hole"]')?.dataset.ilmtState;
}

describe("claim effect", () => {
  it("sends learn-word once when the effect is clicked", async () => {
    const sendLearn = vi.fn().mockResolvedValue({
      ok: true,
      created: true,
      dueAt: 123,
      nextDueLabel: "10 分钟后",
    });
    openClaimCard(sendLearn);

    clickEffect();
    await vi.advanceTimersByTimeAsync(620);

    expect(sendLearn).toHaveBeenCalledTimes(1);
    expect(sendLearn.mock.calls[0][0]).toMatchObject({
      type: "learn-word",
      termLang: "en",
      surface: "outlive",
      meaning: "比……存在得更久",
      mascotId: "gopher-hole",
    });
    expect(effectState()).toBe("settled");
  });

  it("announces the claim in the card's live region", async () => {
    const sendLearn = vi.fn().mockResolvedValue({
      ok: true,
      created: true,
      dueAt: 123,
      nextDueLabel: "10 分钟后",
    });
    openClaimCard(sendLearn);

    clickEffect();
    await vi.advanceTimersByTimeAsync(620);

    const live = document.querySelector('[role=tooltip] [aria-live="polite"]');
    expect(live?.textContent).toBe("已收录");
  });

  it("renders the known state without resending", async () => {
    const sendLearn = vi.fn().mockResolvedValue({
      ok: true,
      created: false,
      dueAt: 123,
      nextDueLabel: "10 分钟后",
    });
    openClaimCard(sendLearn);
    const text = document.querySelector("p")!.firstChild!;

    clickEffect();
    await vi.advanceTimersByTimeAsync(620);
    expect(effectState()).toBe("known");

    stubCaret(text, 0);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 28 }));
    vi.advanceTimersByTime(200);
    expect(document.querySelector("[role=tooltip]")).toBeNull();

    stubCaret(text, 20);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
    vi.advanceTimersByTime(150);

    // Reopening shows the quiet end state instead of replaying the animation.
    expect(effectState()).toBe("known");

    clickEffect();
    await vi.advanceTimersByTimeAsync(620);

    expect(sendLearn).toHaveBeenCalledTimes(1);
    expect(effectState()).toBe("known");
  });

  it("leaves the effect retryable when the write fails", async () => {
    const sendLearn = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({
      ok: true,
      created: true,
      dueAt: 123,
      nextDueLabel: "10 分钟后",
    });
    openClaimCard(sendLearn);

    clickEffect();
    await vi.advanceTimersByTimeAsync(620);
    expect(effectState()).toBe("idle");

    clickEffect();
    await vi.advanceTimersByTimeAsync(620);

    expect(sendLearn).toHaveBeenCalledTimes(2);
    expect(effectState()).toBe("settled");
  });

  it("reserves room below the word for the effect", () => {
    openCard();
    const word = document.querySelector<HTMLElement>(".ilmt-gloss-word")!;
    expect(word.style.marginBottom).toBe("48px");
  });

  it("mounts exactly one effect inside the card", () => {
    openCard();
    expect(document.querySelectorAll("[role=tooltip] [data-ilmt-effect]")).toHaveLength(1);
    expect(document.querySelector("[role=tooltip]")?.textContent).not.toContain("已抓住");
  });

  it("does not put extra-language glosses on the card", () => {
    stubFrame();
    stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document);
    controller.start();
    controller.setParagraph(
      "p_1",
      [text],
      [{ surface: "outlive", meaning: "比……存在得更久", glosses: { es: "sobrevivir" } }],
      "en",
    );
    stubRangeRect();
    stubCaret(text, 20);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
    vi.advanceTimersByTime(150);

    const card = document.querySelector("[role=tooltip]")!;
    expect(card.textContent).toContain("比……存在得更久");
    expect(card.textContent).not.toContain("sobrevivir");
  });
});
