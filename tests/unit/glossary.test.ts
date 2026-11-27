import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlossController, type GlossControllerDeps } from "../../src/content/glossary";
import { getEffect } from "../../src/content/effects";
import type { ClaimEffect } from "../../src/content/effects/types";
import type { GlossaryNote, LearningState, LearningWord } from "../../src/shared/types";

function stubHighlights(): Map<string, unknown> {
  const registry = new Map<string, unknown>();
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
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

const CARD_RECT = {
  left: 8,
  top: 8,
  right: 288,
  bottom: 128,
  width: 280,
  height: 120,
  x: 8,
  y: 8,
};

function stubCardRect(rect: typeof CARD_RECT = CARD_RECT): void {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

function stubViewport(height: number, width = 1024): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  delete (HTMLElement.prototype as unknown as { getBoundingClientRect?: unknown })
    .getBoundingClientRect;
  delete (window as unknown as { innerHeight?: number }).innerHeight;
  delete (window as unknown as { innerWidth?: number }).innerWidth;
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
    expect(card.querySelector(".ilmt-gloss-example")).toBeNull();
    expect(card.textContent).not.toContain("Small tools often outlive their makers.");
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
    // The claim effect may legitimately mount its own image; only the text
    // slots must stay free of model-provided markup.
    expect(card.querySelector('[class*="meaning"] img')).toBeNull();
    expect(card.querySelector('[class*="example"] img')).toBeNull();
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

describe("card layers, positioning, and the 译 line", () => {
  function showCardFor(options: {
    notes?: GlossaryNote[];
    html?: string;
    rangeRect?: DOMRect;
    cardRect?: typeof CARD_RECT;
    viewport?: { width: number; height: number };
  }): HTMLElement {
    stubFrame();
    stubHighlights();
    document.body.innerHTML =
      options.html ?? `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document, {
      resolveEffect: () => getEffect("gopher-hole")!,
    });
    controller.start();
    controller.setParagraph(
      "p_1",
      [text],
      options.notes ?? [{ surface: "outlive", meaning: "比……存在得更久" }],
    );
    stubRangeRect(options.rangeRect);
    if (options.cardRect) stubCardRect(options.cardRect);
    if (options.viewport) stubViewport(options.viewport.height, options.viewport.width);
    stubCaret(text, 20);
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }),
    );
    vi.advanceTimersByTime(150);
    return document.querySelector("[role=tooltip]") as HTMLElement;
  }

  it("never renders the legacy source example", () => {
    const card = showCardFor({
      notes: [
        {
          surface: "outlive",
          pos: "v.",
          meaning: "比……存在得更久",
          example: "Small tools often outlive their makers.",
        },
      ],
    });
    expect(card.querySelector(".ilmt-gloss-example")).toBeNull();
    expect(card.textContent).not.toContain("Small tools often outlive their makers.");
  });

  it("stacks exactly one node per layer: word → meaning", () => {
    const card = showCardFor({
      notes: [{ surface: "outlive", meaning: "比……存在得更久", translated: "存在得更久" }],
    });
    const layers = Array.from(
      card.querySelectorAll(".ilmt-gloss-word, .ilmt-gloss-meaning"),
    ).map((node) => node.className);
    expect(layers).toEqual(["ilmt-gloss-word", "ilmt-gloss-meaning"]);
    expect(card.querySelectorAll(".ilmt-gloss-meaning")).toHaveLength(1);
    expect(card.querySelectorAll(".ilmt-gloss-word")).toHaveLength(1);
  });

  it("keeps the translated wording out of the card, even when the note carries it", () => {
    const withTranslated = showCardFor({
      notes: [{ surface: "outlive", meaning: "比……存在得更久", translated: "存在得更久" }],
    });
    // `translated` still drives the in-translation highlight (next test); the
    // card itself must not repeat it as a third, near-duplicate line.
    expect(withTranslated.querySelector(".ilmt-gloss-translated")).toBeNull();
    expect(withTranslated.querySelector(".ilmt-gloss-translated-line")).toBeNull();
    expect(withTranslated.textContent).not.toContain("译 ·");

    document.body.innerHTML = "";
    const withoutTranslated = showCardFor({
      notes: [{ surface: "outlive", meaning: "比……存在得更久" }],
    });
    expect(withoutTranslated.querySelector(".ilmt-gloss-translated-line")).toBeNull();
  });

  it("lights the translated term while the card is open and clears it on leave", () => {
    const registry = stubHighlights();
    stubFrame();
    document.body.innerHTML =
      `<p>Small tools often outlive their makers.</p>` +
      `<span class="ilmt-tr ilmt-block" data-ilmt-for="p_1">小工具往往比制造者存在得更久。</span>`;
    const text = document.querySelector("p")!.firstChild!;
    const translationText = document.querySelector(".ilmt-tr")!.firstChild!;
    const controller = createGlossController(document, {
      resolveEffect: () => getEffect("gopher-hole")!,
    });
    controller.start();
    controller.setParagraph("p_1", [text], [
      { surface: "outlive", meaning: "比……存在得更久", translated: "存在得更久" },
    ]);
    stubRangeRect();
    stubCaret(text, 20);
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }),
    );
    vi.advanceTimersByTime(150);

    const pair = registry.get("ilmt-gloss-pair") as Set<Range>;
    expect(pair.size).toBe(1);
    const range = [...pair][0];
    expect(range.startContainer).toBe(translationText);
    expect((range.startContainer.parentElement as Element).closest(".ilmt-tr")).not.toBeNull();
    // Only the source term is annotated; the pair highlight never adds a second one.
    expect((registry.get("ilmt-gloss") as Set<Range>).size).toBe(1);

    stubCaret(text, 0);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 28 }));
    vi.advanceTimersByTime(180);
    expect(registry.get("ilmt-gloss-pair")).toBeUndefined();
    expect((registry.get("ilmt-gloss") as Set<Range>).size).toBe(1);
  });

  it("keeps the card inside a 300px-tall viewport and above a word near the bottom", () => {
    const card = showCardFor({
      rangeRect: { left: 10, top: 280, right: 70, bottom: 296, width: 60, height: 16 } as DOMRect,
      cardRect: CARD_RECT,
      viewport: { width: 1024, height: 300 },
    });
    const top = parseFloat(card.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(172);
    // The card sits above the word and never covers it.
    expect(top + CARD_RECT.height).toBeLessThanOrEqual(280);
  });

  it("keeps an 8px top margin when the word is at the very top", () => {
    const card = showCardFor({
      rangeRect: { left: 10, top: 0, right: 70, bottom: 16, width: 60, height: 16 } as DOMRect,
      cardRect: CARD_RECT,
      viewport: { width: 1024, height: 300 },
    });
    expect(parseFloat(card.style.top)).toBeGreaterThanOrEqual(8);
  });
});

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

  it("falls back to the first registered effect for a legacy fixed id", () => {
    stubFrame();
    stubHighlights();
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const controller = createGlossController(document, {
      getEffectSettings: () => ({
        mode: "fixed",
        fixedId: "gopher",
        enabledIds: [],
        animations: true,
      }),
    });
    controller.start();
    controller.setParagraph("p_1", [text], [{ surface: "outlive", meaning: "比……存在得更久" }], "en");
    stubRangeRect();
    stubCaret(text, 20);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
    vi.advanceTimersByTime(150);

    expect(
      document.querySelector('[role=tooltip] [data-ilmt-effect="gopher-hole"]'),
    ).toBeTruthy();
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

describe("card inner scrolling (v6)", () => {
  it("keeps the card open when the card itself or a child inside it scrolls", () => {
    const card = openCard();

    card.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(document.querySelector("[role=tooltip]")).toBeTruthy();

    const child = card.querySelector(".ilmt-gloss-word")!;
    child.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(document.querySelector("[role=tooltip]")).toBeTruthy();
  });

  it("still hides the card on an outside-element scroll", () => {
    openCard();

    document.body.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(document.querySelector("[role=tooltip]")).toBeNull();
  });

  it("still hides the card on a window scroll", () => {
    openCard();

    window.dispatchEvent(new Event("scroll"));

    expect(document.querySelector("[role=tooltip]")).toBeNull();
  });
});

// --- cross-page known words and the ask bridge (v8) ---

function storedWord(over: Partial<LearningWord> = {}): LearningWord {
  return {
    id: "en:outlive",
    termLang: "en",
    surface: "outlive",
    glosses: [],
    glossLang: "zh",
    contexts: [],
    status: "learning",
    box: 0,
    dueAt: 0,
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: 0,
    reviews: [],
    reviewsCount: 0,
    correctCount: 0,
    checksSinceSpot: 0,
    ...over,
  };
}

function learningState(words: LearningWord[]): LearningState {
  return { version: 1, words, stats: { day: "", todayReviewed: 0 }, updatedAt: 0 };
}

function textNodesOf(root: Element): Node[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  return nodes;
}

describe("cross-page known words and the ask bridge (v8)", () => {
  interface OpenOptions {
    html?: string;
    surface?: string;
    meaning?: string;
    termLang?: string;
  }

  async function openWith(
    depsOverrides: GlossControllerDeps,
    options: OpenOptions = {},
  ): Promise<{ controller: ReturnType<typeof createGlossController>; text: Text; card: HTMLElement }> {
    stubFrame();
    stubHighlights();
    document.body.innerHTML = options.html ?? `<p>Small tools often outlive their makers.</p>`;
    const paragraph = document.querySelector("p")!;
    const text = paragraph.firstChild as Text;
    const controller = createGlossController(document, depsOverrides);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    controller.setParagraph(
      "p_1",
      [text],
      [{ surface: options.surface ?? "outlive", meaning: options.meaning ?? "比……存在得更久" }],
      options.termLang ?? "en",
    );
    stubRangeRect();
    stubCaret(text, 20);
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(150);
    return { controller, text, card: document.querySelector("[role=tooltip]") as HTMLElement };
  }

  it("shows a stored word's mascot in the known pose without claiming again", async () => {
    const sendLearn = vi.fn();
    const { card } = await openWith({
      sendLearn,
      loadLearning: async () => learningState([storedWord({ mascotId: "cat-hoard" })]),
    });

    const effect = card.querySelector('[data-ilmt-effect="cat-hoard"]')!;
    expect(effect).not.toBeNull();
    expect(effect.getAttribute("data-ilmt-state")).toBe("known");

    effect
      .querySelector("button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);
    expect(sendLearn).not.toHaveBeenCalled();
  });

  it("shows an auto-claimed word without a mascot in the known pose", async () => {
    const { card } = await openWith({
      sendLearn: vi.fn(),
      loadLearning: async () => learningState([storedWord()]),
    });

    const effect = card.querySelector("[data-ilmt-effect]")!;
    expect(effect).not.toBeNull();
    expect(effect.getAttribute("data-ilmt-state")).toBe("known");
  });

  it("syncs known words from live storage changes and stops listening on stop()", async () => {
    const listeners: Array<(changes: unknown, area: string) => void> = [];
    const removeListener = vi.fn();
    const chromeStorage = chrome.storage as unknown as {
      onChanged?: unknown;
    };
    const original = chromeStorage.onChanged;
    chromeStorage.onChanged = {
      addListener: (cb: (changes: unknown, area: string) => void) => listeners.push(cb),
      removeListener,
    };

    try {
      const { controller, text, card } = await openWith({
        sendLearn: vi.fn(),
        resolveEffect: () => getEffect("gopher-hole")!,
      });
      expect(listeners).toHaveLength(1);
      expect(card.querySelector("[data-ilmt-effect]")!.getAttribute("data-ilmt-state")).toBe(
        "idle",
      );

      // A claim from another page/tab turns the pose known.
      listeners[0](
        { learning: { newValue: learningState([storedWord({ mascotId: "cat-hoard" })]) } },
        "local",
      );
      stubCaret(text, 0);
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 28 }));
      await vi.advanceTimersByTimeAsync(200);
      stubCaret(text, 20);
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
      await vi.advanceTimersByTimeAsync(150);
      expect(
        document
          .querySelector("[role=tooltip] [data-ilmt-effect]")!
          .getAttribute("data-ilmt-state"),
      ).toBe("known");

      // A remote deletion drops it again.
      listeners[0]({ learning: { newValue: learningState([]) } }, "local");
      stubCaret(text, 0);
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 28 }));
      await vi.advanceTimersByTimeAsync(200);
      stubCaret(text, 20);
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 28 }));
      await vi.advanceTimersByTimeAsync(150);
      expect(
        document
          .querySelector("[role=tooltip] [data-ilmt-effect]")!
          .getAttribute("data-ilmt-state"),
      ).toBe("idle");

      controller.stop();
      expect(removeListener).toHaveBeenCalledWith(listeners[0]);
    } finally {
      if (original === undefined) delete chromeStorage.onChanged;
      else chromeStorage.onChanged = original;
    }
  });

  it("renders 问侧栏 inside the word header and hands the term to onAsk", async () => {
    const onAsk = vi.fn();
    const { card } = await openWith({
      onAsk,
      resolveEffect: () => getEffect("gopher-hole")!,
    });

    const word = card.querySelector(".ilmt-gloss-word")!;
    const ask = word.querySelector(".ilmt-gloss-ask") as HTMLButtonElement;
    expect(ask).not.toBeNull();
    expect(ask.textContent).toBe("问侧栏");
    // Exactly the two-layer card structure is preserved.
    expect(card.querySelectorAll(".ilmt-gloss-word")).toHaveLength(1);
    expect(card.querySelectorAll(".ilmt-gloss-meaning")).toHaveLength(1);

    ask.click();

    expect(onAsk).toHaveBeenCalledTimes(1);
    const [surface, range] = onAsk.mock.calls[0];
    expect(surface).toBe("outlive");
    expect(range.toString()).toBe("outlive");
    expect(document.querySelector("[role=tooltip]")).toBeNull();
  });

  it("omits the ask button when no onAsk handler is configured", () => {
    const card = openCard();
    expect(card.querySelector(".ilmt-gloss-ask")).toBeNull();
  });

  it("opens and keeps the card for a term split across inline elements", async () => {
    stubFrame();
    const registry = stubHighlights();
    document.body.innerHTML = `<p>We need to look <em>up</em> now.</p>`;
    const paragraph = document.querySelector("p")!;
    const controller = createGlossController(document, {
      resolveEffect: () => getEffect("gopher-hole")!,
    });
    controller.start();
    controller.setParagraph(
      "p_1",
      textNodesOf(paragraph),
      [{ surface: "look up", meaning: "查阅" }],
      "en",
    );

    expect(controller.count()).toBe(1);
    const highlighted = [...(registry.get("ilmt-gloss") as Set<Range>)];
    expect(highlighted[0].toString()).toBe("look up");

    const lookText = paragraph.firstChild as Text;
    const upText = paragraph.querySelector("em")!.firstChild as Text;
    stubRangeRect();

    stubCaret(lookText, 13);
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(document.querySelector("[role=tooltip]")).not.toBeNull();

    // Moving onto the second half of the term keeps the same card open.
    stubCaret(upText, 1);
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 40, clientY: 28, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(document.querySelector("[role=tooltip]")).not.toBeNull();

    stubCaret(lookText, 0);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 28 }));
    await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelector("[role=tooltip]")).toBeNull();
  });
});

describe("page-aware card theme", () => {
  function showThemed(
    getTheme: () => "system" | "light" | "dark",
    background: string,
  ): { card: HTMLElement; mount: ReturnType<typeof vi.fn> } {
    stubFrame();
    stubHighlights();
    document.body.style.backgroundColor = background;
    document.body.innerHTML = `<p>Small tools often outlive their makers.</p>`;
    const text = document.querySelector("p")!.firstChild!;
    const mount = vi.fn(() => ({
      setState: () => {},
      play: () => {},
      destroy: () => {},
    }));
    const effect = {
      id: "fake",
      label: "假",
      summary: "",
      reserve: { above: 0, below: 0 },
      mount,
    } as unknown as ClaimEffect;
    const controller = createGlossController(document, {
      resolveEffect: () => effect,
      getTheme,
    });
    controller.start();
    controller.setParagraph("p_1", [text], [
      { surface: "outlive", meaning: "比……存在得更久" },
    ]);
    stubRangeRect();
    stubCaret(text, 20);
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 30, clientY: 28, bubbles: true }),
    );
    vi.advanceTimersByTime(150);
    return {
      card: document.querySelector("[role=tooltip]") as HTMLElement,
      mount,
    };
  }

  it("uses an explicit dark preference even on light paper", () => {
    const { card, mount } = showThemed(() => "dark", "rgb(255, 255, 255)");
    expect(card.dataset.theme).toBe("dark");
    expect(mount.mock.calls[0][0]).toMatchObject({ theme: "dark" });
  });

  it("detects a dark page under the system preference", () => {
    const { card, mount } = showThemed(() => "system", "rgb(17, 19, 24)");
    expect(card.dataset.theme).toBe("dark");
    expect(mount.mock.calls[0][0]).toMatchObject({ theme: "dark" });
  });

  it("keeps the light card on a light page", () => {
    const { card, mount } = showThemed(() => "system", "rgb(250, 250, 250)");
    expect(card.dataset.theme).toBe("light");
    expect(mount.mock.calls[0][0]).toMatchObject({ theme: "light" });
  });
});
