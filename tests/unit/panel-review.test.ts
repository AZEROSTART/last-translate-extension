import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReviewQueue, mountReview } from "../../src/panel/review";
import type { ClaimEffect } from "../../src/content/effects/types";
import type { LearningWord, LearningState } from "../../src/shared/types";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function word(index: number, over: Partial<LearningWord> = {}): LearningWord {
  return {
    id: `en:word${index}`,
    termLang: "en",
    surface: `word${index}`,
    glosses: [{ lang: "zh", meaning: `词${index}`, source: "translation", at: NOW }],
    glossLang: "zh",
    contexts: [
      { sentence: `This is word${index} in a sentence.`, pageUrl: "https://x.test/a", at: NOW },
    ],
    status: "learning",
    box: 0,
    dueAt: NOW - HOUR,
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW - HOUR,
    lastSeenAt: NOW - HOUR,
    reviews: [],
    reviewsCount: 0,
    correctCount: 0,
    checksSinceSpot: 0,
    ...over,
  };
}

function state(words: LearningWord[]): LearningState {
  return { version: 1, words, stats: { day: "2026-11-12", todayReviewed: 0 }, updatedAt: NOW };
}

function mount(words: LearningWord[]) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const answer = vi.fn(async (message: { id: string; grade: string }) => ({
    ok: true as const,
    word: { ...words.find((item) => item.id === message.id)!, box: 1 },
  }));
  const view = mountReview(root, {
    getState: async () => state(words),
    answer,
    now: () => NOW,
  });
  return { root, view, answer };
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("buildReviewQueue", () => {
  it("queues only due words, filtered by term language and sorted by dueAt", () => {
    const words = [
      word(1, { id: "en:due", surface: "due", dueAt: NOW - 1000 }),
      word(2, { id: "es:actual", termLang: "es", surface: "actual", dueAt: NOW - 2000 }),
      word(3, { id: "en:future", surface: "future", dueAt: NOW + HOUR }),
      word(4, { id: "en:mastered", status: "mastered", dueAt: null }),
    ];

    expect(buildReviewQueue(state(words), { termLang: "all", now: NOW }).map((w) => w.id)).toEqual([
      "es:actual",
      "en:due",
    ]);
    expect(buildReviewQueue(state(words), { termLang: "es", now: NOW }).map((w) => w.id)).toEqual([
      "es:actual",
    ]);
    expect(buildReviewQueue(state(words), { termLang: "fr", now: NOW })).toEqual([]);
  });
});

describe("mountReview", () => {
  it("renders the word with a blanked sentence and reveals the answer on demand", async () => {
    const { root, view } = mount([
      word(1, {
        surface: "outlive",
        pos: "v.",
        contexts: [
          {
            sentence: "Small tools often outlive their larger competitors.",
            pageUrl: "https://x.test/a",
            at: NOW,
          },
        ],
        glosses: [
          { lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW },
          { lang: "es", meaning: "sobrevivir", source: "translation", at: NOW },
        ],
      }),
    ]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("outlive");
    expect(root.querySelector(".ilmt-review-pos")?.textContent).toBe("v.");
    expect(root.querySelector(".ilmt-review-sentence")?.textContent).toContain("____");
    expect(root.querySelector(".ilmt-review-sentence")?.textContent).not.toContain("outlive");
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();

    root.querySelector<HTMLButtonElement>(".ilmt-review-reveal")!.click();

    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比……存在得更久");
    expect(root.querySelector(".ilmt-review-meaning-more")?.textContent).toContain("sobrevivir");
    expect(root.querySelector(".ilmt-review-sentence-full")?.textContent).toContain("outlive");
  });

  it("shows the finish card when the queue is empty", async () => {
    const { root, view } = mount([]);
    await view.refresh();

    expect(root.textContent).toContain("今天没有要复习的词");
    expect(root.textContent).toContain("本轮");
  });
});

describe("review card effect", () => {
  function fakeEffect(over: Partial<ClaimEffect> & { destroy?: () => void } = {}): ClaimEffect {
    const { destroy, ...rest } = over;
    return {
      id: "fake",
      label: "测试特效",
      summary: "",
      reserve: { above: 0, below: 0 },
      mount: () => ({ setState: () => {}, destroy: destroy ?? (() => {}) }),
      ...rest,
    };
  }

  function mountWithEffect(words: LearningWord[], effect: ClaimEffect) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = mountReview(root, {
      getState: async () => state(words),
      answer: async () => ({ ok: true, word: words[0] }),
      effect: () => effect,
      now: () => NOW,
    });
    return { root, view };
  }

  it("mounts the word's effect as a decorative avatar only", async () => {
    const { root, view } = mountWithEffect([word(1, { mascotId: "gopher-hole" })], fakeEffect({
      mount: (ctx) => {
        const button = document.createElement("button");
        button.textContent = "hit";
        ctx.root.appendChild(button);
        return { setState: () => {}, destroy: () => {} };
      },
    }));
    await view.refresh();

    const mascot = root.querySelector<HTMLElement>(".ilmt-review-mascot")!;
    expect(mascot.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector(".ilmt-review-effect-host")).toBeTruthy();
    expect(mascot.querySelector("button")!.tabIndex).toBe(-1);
    view.destroy();
  });

  it("falls back to the first registered effect for a legacy mascotId", async () => {
    const legacy = word(1, { mascotId: "gopher" });
    const root = document.createElement("div");
    document.body.appendChild(root);
    // The real gopher-hole effect is registered by importing review.ts.
    const view = mountReview(root, {
      getState: async () => state([legacy]),
      answer: async () => ({ ok: true, word: legacy }),
      now: () => NOW,
    });
    await view.refresh();

    const mascot = root.querySelector<HTMLElement>(".ilmt-review-mascot")!;
    expect(mascot.querySelector("svg")).toBeTruthy();
    expect(mascot.getAttribute("aria-hidden")).toBe("true");
    view.destroy();
  });

  it("destroys the avatar handle on re-render and on view destroy", async () => {
    const destroy = vi.fn();
    const { root, view } = mountWithEffect([word(1)], fakeEffect({ destroy }));
    await view.refresh();

    const beforeRerender = destroy.mock.calls.length;
    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    expect(destroy.mock.calls.length).toBeGreaterThan(beforeRerender);

    const beforeDestroy = destroy.mock.calls.length;
    view.destroy();
    expect(destroy.mock.calls.length).toBeGreaterThan(beforeDestroy);
  });

  it("keeps the review usable when an effect throws on mount", async () => {
    const { root, view } = mountWithEffect([word(1, { surface: "outlive" })], fakeEffect({
      mount: () => {
        throw new Error("boom");
      },
    }));
    await view.refresh();

    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("outlive");
    expect(root.querySelector(".ilmt-review-grade")).toBeTruthy();
    view.destroy();
  });
});

describe("spot check integration", () => {
  const spotWords = (): LearningWord[] => [
    word(1, {
      surface: "outlive",
      checksSinceSpot: 2,
      dueAt: NOW - 5 * HOUR,
      glosses: [{ lang: "zh", meaning: "比…活得久", source: "translation", at: NOW }],
    }),
    word(2, { glosses: [{ lang: "zh", meaning: "实际的", source: "translation", at: NOW }] }),
    word(3, { glosses: [{ lang: "zh", meaning: "当前的", source: "translation", at: NOW }] }),
    word(4, { glosses: [{ lang: "zh", meaning: "生存", source: "translation", at: NOW }] }),
  ];

  it("turns the third review into a four-way question that waits for 下一张", async () => {
    const { root, view, answer } = mount(spotWords());
    await view.refresh();

    const options = [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")];
    expect(options).toHaveLength(4);
    options.find((option) => option.textContent === "比…活得久")!.click();

    // Correct answers must stay on the card and show the meaning too.
    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-grade")).toBeNull();
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比…活得久");
    expect(root.querySelector(".ilmt-review-spot-note")).toBeNull();

    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "review-answer",
          id: "en:word1",
          grade: "good",
          spot: true,
          spotCorrect: true,
        }),
      );
    });
  });

  it("shows the correction and the answer after a wrong choice", async () => {
    const { root, view, answer } = mount(spotWords());
    await view.refresh();

    const options = [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")];
    options.find((option) => option.textContent === "实际的")!.click();

    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-spot-note")?.textContent).toContain("比…活得久");
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比…活得久");

    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({ grade: "again", spot: true, spotCorrect: false }),
      );
    });
  });
});

describe("reveal after grading", () => {
  it("reveals the meaning on the same card as soon as a grade is picked", async () => {
    const { root, view, answer } = mount([
      word(1, {
        surface: "outlive",
        glosses: [{ lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW }],
      }),
    ]);
    await view.refresh();
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比……存在得更久");
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("outlive");
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 1");
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
    expect(answer).not.toHaveBeenCalled();
  });

  it("lets the user change the grade before committing", async () => {
    const { root, view, answer } = mount([word(1)]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    expect(root.querySelector('[data-grade="good"]')!.getAttribute("aria-pressed")).toBe("true");

    root.querySelector<HTMLButtonElement>('[data-grade="again"]')!.click();

    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelector('[data-grade="good"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(root.querySelector('[data-grade="again"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector(".ilmt-review-meaning")).toBeTruthy();
  });

  it("commits exactly once with the final grade on 下一张", async () => {
    const words = [word(1), word(2)];
    const { root, view, answer } = mount(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-grade="hard"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1);
    });
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "review-answer", id: "en:word1", grade: "hard" }),
    );
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
    });
  });

  it("lists every stored language under the primary meaning", async () => {
    const { root, view } = mount([
      word(1, {
        glosses: [
          { lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW },
          { lang: "ja", meaning: "より長く生き残る", source: "translation", at: NOW },
        ],
        glossLang: "zh",
      }),
    ]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比……存在得更久");
    expect(root.querySelector(".ilmt-review-meaning-more")?.textContent).toContain(
      "日语 · より長く生き残る",
    );
  });

  it("keeps the card and the selection when the answer call fails", async () => {
    const words = [word(1), word(2)];
    const { root, view, answer } = mount(words);
    await view.refresh();
    answer.mockImplementationOnce(
      async () => ({ ok: false }) as unknown as { ok: true; word: LearningWord },
    );

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1);
    });
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 2");
    expect(root.querySelector('[data-grade="good"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
  });

  it("does not rebuild the queue while a grade is pending", async () => {
    const words = [word(1), word(2)];
    const { root, view } = mount(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    await view.refresh();

    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
  });

  it("commits the pending grade when the round is ended", async () => {
    const words = [word(1), word(2)];
    const { root, view, answer } = mount(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1);
    });
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ id: "en:word1", grade: "good" }));
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done")).toBeTruthy();
    });
  });

  it("offers 继续复习 after an explicit end", async () => {
    const { root, view } = mount([word(1)]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-continue")).toBeTruthy();
    });

    root.querySelector<HTMLButtonElement>(".ilmt-review-continue")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    });
  });
});

describe("review invariant guards", () => {
  it("expands the answer without offering 下一张 before a grade is picked", async () => {
    const { root, view } = mount([word(1)]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>(".ilmt-review-reveal")!.click();

    expect(root.querySelector(".ilmt-review-meaning")).toBeTruthy();
    expect(root.querySelector(".ilmt-review-next")).toBeNull();
    expect(root.querySelector(".ilmt-review-grade")).toBeTruthy();
  });

  it("keeps a graded spot card locked when the answer language changes", async () => {
    const words = [
      word(1, {
        surface: "outlive",
        checksSinceSpot: 2,
        dueAt: NOW - 5 * HOUR,
        glosses: [{ lang: "zh", meaning: "比…活得久", source: "translation", at: NOW }],
      }),
      word(2, { glosses: [{ lang: "zh", meaning: "实际的", source: "translation", at: NOW }] }),
      word(3, { glosses: [{ lang: "zh", meaning: "当前的", source: "translation", at: NOW }] }),
      word(4, { glosses: [{ lang: "zh", meaning: "生存", source: "translation", at: NOW }] }),
      word(5, { glosses: [{ lang: "ja", meaning: "生き残る", source: "translation", at: NOW }] }),
    ];
    const { root, view } = mount(words);
    await view.refresh();

    [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")]
      .find((option) => option.textContent === "比…活得久")!
      .click();
    expect(root.querySelector(".ilmt-review-grade")).toBeNull();

    const select = root.querySelector<HTMLSelectElement>(".ilmt-review-gloss-lang")!;
    select.value = "ja";
    select.dispatchEvent(new Event("change"));

    expect(root.querySelector(".ilmt-review-grade")).toBeNull();
  });
});
