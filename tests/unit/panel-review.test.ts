import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReviewQueue, mountReview, type ReviewOptions } from "../../src/panel/review";
import type { ClaimContext, ClaimEffect } from "../../src/content/effects/types";
import {
  applyReviewAnswer,
  localDay,
  undoReviewAnswer,
} from "../../src/shared/learning-storage";
import type {
  LearningGrade,
  LearningWord,
  LearningState,
  ReviewAnswerResponse,
} from "../../src/shared/types";

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

function state(
  words: LearningWord[],
  stats?: Partial<LearningState["stats"]>,
): LearningState {
  return {
    version: 1,
    words,
    stats: { day: "2026-11-12", todayReviewed: 0, ...stats },
    updatedAt: NOW,
  };
}

function mount(words: LearningWord[], over: Partial<ReviewOptions> = {}) {
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
    ...over,
  });
  return { root, view, answer };
}

/** A `mount` whose answer/undo/getState share one simulated store. */
function mountStored(words: LearningWord[], over: Partial<ReviewOptions> = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let current: LearningState = state(words);

  const answer = vi.fn(
    async (message: { id: string; grade: LearningGrade; spot?: boolean; spotCorrect?: boolean }) => {
      const next = applyReviewAnswer(
        current,
        {
          id: message.id,
          grade: message.grade,
          ...(message.spot !== undefined ? { spot: message.spot } : {}),
          ...(message.spotCorrect !== undefined ? { spotCorrect: message.spotCorrect } : {}),
        },
        NOW,
      );
      if (!next.word) return { ok: false } as unknown as ReviewAnswerResponse;
      current = next.state;
      return { ok: true as const, word: next.word };
    },
  );
  const undo = vi.fn(async (message: { id: string }) => {
    const next = undoReviewAnswer(current, { id: message.id }, NOW + 1000);
    if (!next.word) return { ok: false as const, reason: next.reason };
    current = next.state;
    return { ok: true as const, word: next.word };
  });

  const view = mountReview(root, {
    getState: async () => current,
    answer,
    undo,
    now: () => NOW,
    ...over,
  });
  return { root, view, answer, undo };
}

/** An effect whose performance is observable, without any real animation. */function stageEffect(play = vi.fn()) {
  return {
    id: "fake",
    label: "假",
    summary: "",
    reserve: { above: 0, below: 0 },
    mount: () => ({ setState: () => {}, play, destroy: () => {} }),
  } as unknown as ClaimEffect;
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

  it("guides a brand-new library instead of reporting three zeros", async () => {
    const { root, view } = mount([]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("还没有收录的词");
    expect(root.textContent).toContain("浅灰");
    expect(root.textContent).toContain("⌥A");
    expect(root.textContent).not.toContain("本轮");
    expect(root.textContent).not.toContain("答对");
    expect(root.textContent).not.toContain("明日还有 0");
    expect(root.textContent).not.toContain("今天已复习");
    expect(root.querySelector(".ilmt-review-shelf")).toBeNull();
  });

  it("keeps the library size above everything, counting mastered words", async () => {
    const words = [
      word(1),
      word(2),
      word(3, { status: "mastered", box: 5, dueAt: null }),
    ];
    const { root, view } = mount(words);
    await view.refresh();

    const shelf = root.querySelector<HTMLElement>(".ilmt-review-shelf");
    expect(shelf?.textContent).toBe("已收录 3 个 · 已毕业 1 个");
    const review = root.querySelector(".ilmt-review")!;
    expect(review.firstElementChild).toBe(shelf);
  });

  it("drops the graduated part of the shelf when nothing has graduated", async () => {
    const { root, view } = mount([word(1), word(2), word(3)]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 3 个");
    expect(root.textContent).not.toContain("已毕业");
  });

  it("keeps the shelf before the language chips and unchanged when a chip is picked", async () => {
    const words = [
      word(1),
      word(2, { id: "es:actual", termLang: "es", surface: "actual" }),
    ];
    const { root, view } = mount(words);
    await view.refresh();

    const shelf = root.querySelector<HTMLElement>(".ilmt-review-shelf")!;
    const langs = root.querySelector<HTMLElement>(".ilmt-review-langs")!;
    expect(shelf.compareDocumentPosition(langs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    root.querySelector<HTMLButtonElement>('.ilmt-review-lang[data-lang="es"]')!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-lang.is-active")?.textContent).toContain("西语");
    });
    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 2 个");
  });

  it("keeps the shelf on the card and on both finish pages", async () => {
    const words = [word(1), word(2), word(3)];

    const card = mount(words);
    await card.view.refresh();
    expect(card.root.querySelector(".ilmt-review-card")).toBeTruthy();
    expect(card.root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 3 个");
    card.view.destroy();

    // B: the round was ended with work left.
    const early = mount(words);
    await early.view.refresh();
    early.root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(early.root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(early.root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 3 个");
    early.view.destroy();

    // C: everything is scheduled for later.
    const done = mount(words.map((item) => ({ ...item, dueAt: NOW + HOUR })));
    await done.view.refresh();
    expect(done.root.querySelector(".ilmt-review-done-title")?.textContent).toBe(
      "今天没有要复习的词",
    );
    expect(done.root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 3 个");
    done.view.destroy();
  });

  it("says how many cards are still due when the round is ended early", async () => {
    const words = [word(1), word(2), word(3)];
    let current = state(words);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = mountReview(root, {
      getState: async () => current,
      answer: async (message) => ({
        ok: true as const,
        word: { ...words[0], box: 1, dueAt: NOW + 24 * HOUR, id: message.id },
      }),
      now: () => NOW,
    });
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    // The committed card is now due tomorrow; the other two are still due.
    current = state([
      { ...words[0], box: 1, dueAt: NOW + 24 * HOUR },
      words[1],
      words[2],
    ]);
    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(root.textContent).toContain("还有 2 个到期");
    expect(root.textContent).not.toContain("今天没有要复习的词");
    expect(root.querySelector(".ilmt-review-continue")).toBeTruthy();
  });

  it("counts tomorrow's card in the all-done state", async () => {
    const { root, view } = mount([word(1, { dueAt: NOW + HOUR })]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("今天没有要复习的词");
    expect(root.textContent).toContain("明日还有 1 个");
    expect(root.querySelector(".ilmt-review-continue")).toBeNull();
  });

  it("names 认识 instead of 答对 in the round summary", async () => {
    const words = [word(1), word(2)];
    const { root, view } = mount(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
    });

    root.querySelector<HTMLButtonElement>('[data-grade="hard"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done")).toBeTruthy();
    });
    expect(root.querySelector(".ilmt-review-done-summary")?.textContent).toBe(
      "本轮 2 个 · 认识 1",
    );
    expect(root.textContent).not.toContain("答对");
  });

  it("omits the summary line when nothing was answered and nothing is due", async () => {
    const { root, view } = mount([word(1, { dueAt: NOW + 48 * HOUR })]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-summary")).toBeNull();
    expect(root.textContent).not.toContain("本轮");
    expect(root.textContent).not.toContain("明日还有 0 个");
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


describe("review scene", () => {
  const sceneWord = () =>
    word(1, {
      surface: "outlive",
      glosses: [{ lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW }],
    });

  it("asks the background for a picture on reveal and performs it once", async () => {
    const play = vi.fn();
    const mnemonic = vi.fn().mockResolvedValue({
      ok: true as const,
      mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
    });
    const { root, view } = mount([sceneWord()], {
      mnemonic,
      effect: () => stageEffect(play),
    });
    await view.refresh();

    expect(mnemonic).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('[data-grade="again"]')!.click();

    expect(root.querySelector(".ilmt-review-scene")?.getAttribute("data-scene")).toBe("loading");
    expect(root.querySelector(".ilmt-review-scene-caption")?.textContent).toContain("想一个画面");
    expect(play).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-scene-caption")?.textContent).toBe("猫把词抱进怀里");
    });
    expect(mnemonic).toHaveBeenCalledTimes(1);
    expect(mnemonic).toHaveBeenCalledWith("en:word1");
    expect(play).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".ilmt-review-scene-replay")).toBeTruthy();
    view.destroy();
  });

  it("uses the stored caption without asking again", async () => {
    const mnemonic = vi.fn();
    const play = vi.fn();
    const { root, view } = mount(
      [word(1, { mnemonic: { caption: "地鼠把词拖进洞里", lang: "zh", at: NOW } })],
      { mnemonic, effect: () => stageEffect(play) },
    );
    await view.refresh();
    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(mnemonic).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-scene-caption")?.textContent).toBe("地鼠把词拖进洞里");
    view.destroy();
  });

  it("offers a retry after a failed generation and asks again", async () => {
    const mnemonic = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "no-provider" })
      .mockResolvedValueOnce({
        ok: true as const,
        mnemonic: { caption: "贴纸猫掀起来上色", lang: "zh", at: NOW },
      });
    const { root, view } = mount([sceneWord()], {
      mnemonic,
      effect: () => stageEffect(),
    });
    await view.refresh();
    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-scene-retry")).toBeTruthy();
    });
    expect(mnemonic).toHaveBeenCalledTimes(1);

    root.querySelector<HTMLButtonElement>(".ilmt-review-scene-retry")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-scene-caption")?.textContent).toBe("贴纸猫掀起来上色");
    });
    expect(mnemonic).toHaveBeenCalledTimes(2);
    view.destroy();
  });

  it("replays on 再看一次 without another request", async () => {
    const play = vi.fn();
    const mnemonic = vi.fn().mockResolvedValue({
      ok: true as const,
      mnemonic: { caption: "磁铁把词吸过去", lang: "zh", at: NOW },
    });
    const { root, view } = mount([sceneWord()], {
      mnemonic,
      effect: () => stageEffect(play),
    });
    await view.refresh();
    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    root.querySelector<HTMLButtonElement>(".ilmt-review-scene-replay")!.click();

    expect(play).toHaveBeenCalledTimes(2);
    expect(mnemonic).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("hides the corner mascot once the answer is on screen", async () => {
    const { root, view } = mount([sceneWord()], { effect: () => stageEffect() });
    await view.refresh();

    expect(root.querySelector<HTMLElement>(".ilmt-review-mascot")!.hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    expect(root.querySelector<HTMLElement>(".ilmt-review-mascot")!.hidden).toBe(true);
    view.destroy();
  });

  it("keeps grading available when the scene request throws", async () => {
    const mnemonic = vi.fn().mockRejectedValue(new Error("offline"));
    const { root, view } = mount([sceneWord()], {
      mnemonic,
      effect: () => stageEffect(),
    });
    await view.refresh();
    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-scene-retry")).toBeTruthy());
    expect(root.querySelector(".ilmt-review-grade")).toBeTruthy();
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比……存在得更久");
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

describe("grade previews", () => {
  it("labels every grade with its next-due time, and explains the numbers once", async () => {
    const { root, view } = mount([word(1)]);
    await view.refresh();

    const again = root.querySelector<HTMLElement>('[data-grade="again"]')!;
    const hard = root.querySelector<HTMLElement>('[data-grade="hard"]')!;
    const good = root.querySelector<HTMLElement>('[data-grade="good"]')!;

    expect(again.textContent).toContain("忘了");
    expect(again.textContent).toContain("10 分钟后");
    expect(hard.textContent).toContain("模糊");
    expect(hard.textContent).toContain("10 分钟后");
    expect(good.textContent).toContain("认识");
    expect(good.textContent).toContain("明天");
    for (const button of [again, hard, good]) {
      expect(button.querySelector(".ilmt-review-grade-due")).toBeTruthy();
    }

    const notes = root.querySelectorAll(".ilmt-review-grade-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe("数字是下次见到它的时间");
  });

  it("keeps the second line on every button while the grade is re-picked", async () => {
    const { root, view, answer } = mount([word(1)]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    expect(root.querySelectorAll(".ilmt-review-grade-due")).toHaveLength(3);

    root.querySelector<HTMLButtonElement>('[data-grade="hard"]')!.click();

    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".ilmt-review-grade-due")).toHaveLength(3);
    expect(root.querySelector('[data-grade="good"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(root.querySelector('[data-grade="hard"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("states the derived consequence above 下一张 on a four-way card", async () => {
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
    ];
    const right = mount(words);
    await right.view.refresh();

    [...right.root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")]
      .find((option) => option.textContent === "比…活得久")!
      .click();

    const note = right.root.querySelector<HTMLElement>(".ilmt-review-next-note")!;
    expect(note.textContent).toBe("记为认识 · 明天再见");
    expect(note.nextElementSibling).toBe(right.root.querySelector(".ilmt-review-next"));
    expect(right.root.querySelector(".ilmt-review-grade")).toBeNull();
    expect(right.answer).not.toHaveBeenCalled();
    right.view.destroy();

    // A wrong pick derives 忘了, and the note says so before 下一张 writes it.
    const wrong = mount(words);
    await wrong.view.refresh();
    [...wrong.root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")]
      .find((option) => option.textContent === "实际的")!
      .click();
    expect(wrong.root.querySelector(".ilmt-review-next-note")?.textContent).toBe(
      "记为忘了 · 10 分钟后再见",
    );
    expect(wrong.answer).not.toHaveBeenCalled();
    wrong.view.destroy();
  });
});

describe("receipt and undo", () => {
  async function commitFirst(root: HTMLElement): Promise<void> {
    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-receipt")).toBeTruthy());
  }

  it("shows what was written and offers one undo after 下一张", async () => {
    const { root, view, undo } = mountStored([word(1), word(2)]);
    await view.refresh();
    await commitFirst(root);

    const receipt = root.querySelector<HTMLElement>(".ilmt-review-receipt")!;
    expect(receipt.textContent).toContain("已记录");
    expect(receipt.textContent).toContain("明天再见");
    expect(receipt.getAttribute("role")).toBe("status");
    const button = receipt.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo");
    expect(button?.textContent).toBe("撤销");
    expect(undo).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
  });

  it("undoes once, rolls the counters back and returns focus to the card", async () => {
    const { root, view, answer, undo } = mountStored([word(1), word(2)]);
    await view.refresh();
    await commitFirst(root);

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")).toBeNull();
    });
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 2");
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith({ type: "review-undo", id: "en:word1" });
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    // The returned card is idle: answer closed, all three grades clickable.
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();
    expect(root.querySelectorAll(".ilmt-review-grade")).toHaveLength(3);
    expect(root.querySelector(".ilmt-review-next")).toBeNull();
    expect(document.activeElement).toBe(root.querySelector(".ilmt-review-card"));
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("keeps the receipt and invites a retry after a transient failure", async () => {
    const { root, view, answer } = mountStored([word(1), word(2)], {
      undo: async () => ({ ok: false }),
    });
    await view.refresh();
    await commitFirst(root);

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")?.textContent).toContain("撤销失败");
    });
    expect(root.querySelector(".ilmt-review-receipt")?.textContent).toContain("再试一次");
    expect(root.querySelector(".ilmt-review-receipt-undo")).toBeTruthy();
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown undo call as transient and keeps the button", async () => {
    const { root, view } = mountStored([word(1), word(2)], {
      undo: async () => {
        throw new Error("offline");
      },
    });
    await view.refresh();
    await commitFirst(root);

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")?.textContent).toContain("撤销失败");
    });
    expect(root.querySelector(".ilmt-review-receipt-undo")).toBeTruthy();
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
  });

  it.each(["too-old", "unsupported", "not-latest", "unknown-word"] as const)(
    "stops asking after the terminal reason %s",
    async (reason) => {
      const { root, view } = mountStored([word(1), word(2)], {
        undo: async () => ({ ok: false, reason }),
      });
      await view.refresh();
      await commitFirst(root);

      root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

      await vi.waitFor(() => {
        expect(root.querySelector(".ilmt-review-receipt")?.textContent).toBe("这张改不回来了");
      });
      expect(root.querySelector(".ilmt-review-receipt-undo")).toBeNull();
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
    },
  );

  it("brings a four-way card back as an idle card and does not re-ask it", async () => {
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
    ];
    const { root, view } = mountStored(words);
    await view.refresh();
    expect(root.querySelectorAll(".ilmt-review-option")).toHaveLength(4);

    [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")]
      .find((option) => option.textContent === "比…活得久")!
      .click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-receipt")).toBeTruthy());

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("outlive");
    });
    expect(root.querySelectorAll(".ilmt-review-option")).toHaveLength(0);
    expect(root.querySelectorAll(".ilmt-review-grade")).toHaveLength(3);
  });

  it("undoes from the finish page without resetting the round", async () => {
    const words = [word(1), word(2), word(3)];
    const { root, view } = mountStored(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 3");
    });

    root.querySelector<HTMLButtonElement>('[data-grade="hard"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(root.querySelector(".ilmt-review-receipt")?.textContent).toContain("10 分钟后再见");

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done")).toBeNull();
    });
    expect(root.querySelector(".ilmt-review-receipt")).toBeNull();
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 3");
    expect(root.querySelectorAll(".ilmt-review-grade")).toHaveLength(3);
  });
});

describe("graduation send-off", () => {
  async function finishWith(
    root: HTMLElement,
    clicks: number,
    names: string[] = [],
  ): Promise<void> {
    for (let i = 0; i < clicks; i++) {
      root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
      root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
      const next = names[i];
      if (next) {
        await vi.waitFor(() => {
          expect(root.querySelector(".ilmt-review-word")?.textContent).toBe(next);
        });
      }
    }
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done")).toBeTruthy();
    });
  }

  it("says which word finished the ladder, on the same frame as the shelf", async () => {
    const { root, view } = mountStored([word(1, { box: 5, surface: "word1" })]);
    await view.refresh();
    await finishWith(root, 1);

    expect(root.querySelector(".ilmt-review-graduated")).toBeTruthy();
    expect(root.querySelector(".ilmt-review-graduated-word")?.textContent).toBe("word1 毕业了");
    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe(
      "已收录 1 个 · 已毕业 1 个",
    );
    expect(root.querySelector(".ilmt-review-receipt")?.textContent).toContain("已毕业");
    view.destroy();
  });

  it("stays quiet for an ordinary 认识", async () => {
    const { root, view } = mountStored([word(1)]);
    await view.refresh();
    await finishWith(root, 1);

    expect(root.querySelector(".ilmt-review-graduated")).toBeNull();
    expect(root.textContent).not.toContain("毕业了");
    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 1 个");
    view.destroy();
  });

  it("shows at most three rows and counts the rest in one line", async () => {
    const words = [1, 2, 3, 4].map((i) =>
      word(i, { box: 5, surface: `word${i}`, dueAt: NOW - (10 - i) * HOUR }),
    );
    const { root, view } = mountStored(words);
    await view.refresh();
    await finishWith(root, 4, ["word2", "word3", "word4"]);

    const rows = [...root.querySelectorAll(".ilmt-review-graduated-row")];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector(".ilmt-review-graduated-word")?.textContent)).toEqual(
      ["word1 毕业了", "word2 毕业了", "word3 毕业了"],
    );
    expect(root.querySelector(".ilmt-review-graduated-more")?.textContent).toBe(
      "还有 1 个也毕业了",
    );
    view.destroy();
  });

  it("keeps the early-finish page intact and still names the graduate", async () => {
    const words = [word(1, { box: 5, surface: "word1" }), word(2), word(3)];
    const { root, view } = mountStored(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 3");
    });

    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(root.querySelector(".ilmt-review-graduated-word")?.textContent).toBe("word1 毕业了");
    expect(root.textContent).toContain("还有 2 个到期");
    expect(root.querySelector(".ilmt-review-continue")).toBeTruthy();
    expect(root.querySelector(".ilmt-review-done-today")?.textContent).toBe("今天已复习 1 个");
    view.destroy();
  });

  it("lets one undo take the send-off back, then graduates again without duplicating", async () => {
    const { root, view } = mountStored([word(1, { box: 5, surface: "word1" })]);
    await view.refresh();
    await finishWith(root, 1);

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    });
    expect(root.querySelector(".ilmt-review-graduated")).toBeNull();
    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 1 个");

    await finishWith(root, 1);
    expect(root.querySelectorAll(".ilmt-review-graduated-row")).toHaveLength(1);
    expect(root.querySelector(".ilmt-review-graduated-more")).toBeNull();
    view.destroy();
  });

  it("keeps the words readable when their effect cannot mount", async () => {
    const broken: ClaimEffect = {
      id: "broken",
      label: "坏",
      summary: "",
      reserve: { above: 0, below: 0 },
      mount: () => {
        throw new Error("boom");
      },
    };
    const { root, view } = mountStored([word(1, { box: 5, surface: "outlive" })], {
      effect: () => broken,
    });
    await view.refresh();
    await finishWith(root, 1);

    expect(root.querySelector(".ilmt-review-graduated-word")?.textContent).toBe("outlive 毕业了");
    expect(root.querySelector(".ilmt-review-graduated [data-ilmt-effect]")).toBeNull();
    view.destroy();
  });

  it("mounts the graduation effect as a static, hidden decoration and destroys it", async () => {
    const mounted: ClaimContext[] = [];
    const destroy = vi.fn();
    const effect: ClaimEffect = {
      id: "recording",
      label: "记录",
      summary: "",
      reserve: { above: 0, below: 0 },
      mount: (ctx) => {
        mounted.push(ctx);
        const button = document.createElement("button");
        button.textContent = "hit";
        ctx.root.appendChild(button);
        return {
          setState: (phase) => {
            ctx.root.dataset.ilmtState = phase;
          },
          destroy,
        };
      },
    };
    const { root, view } = mountStored(
      [word(1, { box: 5, surface: "outlive", mascotId: "recording" })],
      { effect: () => effect },
    );
    await view.refresh();
    await finishWith(root, 1);

    const stage = root.querySelector<HTMLElement>(
      ".ilmt-review-graduated-row .ilmt-review-scene-stage",
    )!;
    expect(stage.getAttribute("aria-hidden")).toBe("true");
    expect(stage.querySelector("button")!.tabIndex).toBe(-1);
    expect(stage.dataset.ilmtState).toBe("known");
    const graduationMounts = mounted.filter(
      (ctx) =>
        (ctx.root as HTMLElement).isConnected &&
        ctx.root.closest(".ilmt-review-graduated"),
    );
    expect(graduationMounts).toHaveLength(1);
    expect(graduationMounts.every((ctx) => ctx.animations === false)).toBe(true);

    const afterMount = destroy.mock.calls.length;
    await view.refresh();
    expect(destroy.mock.calls.length).toBeGreaterThan(afterMount);

    const beforeDestroy = destroy.mock.calls.length;
    view.destroy();
    expect(destroy.mock.calls.length).toBeGreaterThan(beforeDestroy);
  });
});

describe("today and coming back", () => {
  const today = localDay(NOW);
  const daysAgo = (days: number) => localDay(NOW - days * 24 * HOUR);

  function mountState(words: LearningWord[], stats: Partial<LearningState["stats"]>) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = mountReview(root, {
      getState: async () => state(words, stats),
      now: () => NOW,
    });
    return { root, view };
  }

  function library(): LearningWord[] {
    return [
      word(1),
      ...Array.from({ length: 20 }, (_, index) => word(index + 2, { dueAt: NOW + HOUR })),
      ...Array.from({ length: 3 }, (_, index) =>
        word(index + 22, { status: "mastered", box: 5, dueAt: null }),
      ),
    ];
  }

  it("counts today's reviews only when the stored day is today", async () => {
    const { root, view } = mountState([word(1, { dueAt: NOW + HOUR })], {
      day: today,
      todayReviewed: 4,
    });
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-today")?.textContent).toBe("今天已复习 4 个");
    view.destroy();
  });

  it("does not report yesterday's count as today's", async () => {
    const { root, view } = mountState([word(1, { dueAt: NOW + HOUR })], {
      day: daysAgo(1),
      todayReviewed: 4,
    });
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("今天没有要复习的词");
    expect(root.querySelector(".ilmt-review-done-today")?.textContent).toBe("今天已复习 0 个");
    expect(root.textContent).not.toContain("已复习 4 个");
    view.destroy();
  });

  it("also zeroes the count on the early-finish page after a day change", async () => {
    const { root, view } = mountState([word(1), word(2)], {
      day: daysAgo(1),
      todayReviewed: 4,
    });
    await view.refresh();

    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(root.querySelector(".ilmt-review-done-today")?.textContent).toBe("今天已复习 0 个");
    view.destroy();
  });

  it("welcomes someone back with the exact gap and the whole library", async () => {
    const { root, view } = mountState(library(), { day: daysAgo(5), todayReviewed: 4 });
    await view.refresh();

    const shelf = root.querySelector(".ilmt-review-shelf")!;
    const comeback = root.querySelector<HTMLElement>(".ilmt-review-return");
    expect(shelf.textContent).toBe("已收录 24 个 · 已毕业 3 个");
    expect(comeback?.textContent).toBe("有 5 天没见了 · 24 个词都还在");
    expect(shelf.nextElementSibling).toBe(comeback);
    view.destroy();
  });

  it("stops counting precise days after two weeks", async () => {
    const { root, view } = mountState(library(), { day: daysAgo(14), todayReviewed: 4 });
    await view.refresh();

    expect(root.querySelector(".ilmt-review-return")?.textContent).toBe(
      "有一阵子没见了 · 24 个词都还在",
    );
    view.destroy();
  });

  it("only speaks up from three days on, with a due word and a real day", async () => {
    const two = mountState(library(), { day: daysAgo(2), todayReviewed: 4 });
    await two.view.refresh();
    expect(two.root.querySelector(".ilmt-review-return")).toBeNull();
    two.view.destroy();

    const three = mountState(library(), { day: daysAgo(3), todayReviewed: 4 });
    await three.view.refresh();
    expect(three.root.querySelector(".ilmt-review-return")?.textContent).toBe(
      "有 3 天没见了 · 24 个词都还在",
    );
    three.view.destroy();

    const never = mountState(library(), { day: "", todayReviewed: 0 });
    await never.view.refresh();
    expect(never.root.querySelector(".ilmt-review-return")).toBeNull();
    never.view.destroy();

    const nothingDue = mountState(
      library().map((item) => ({ ...item, status: "learning" as const, dueAt: NOW + HOUR })),
      { day: daysAgo(5), todayReviewed: 4 },
    );
    await nothingDue.view.refresh();
    expect(nothingDue.root.querySelector(".ilmt-review-return")).toBeNull();
    nothingDue.view.destroy();

    const future = mountState(library(), { day: daysAgo(-5), todayReviewed: 4 });
    await future.view.refresh();
    expect(future.root.querySelector(".ilmt-review-return")).toBeNull();
    future.view.destroy();
  });

  it("falls silent after one review, while the shelf stays", async () => {
    const words = [word(1)];
    let current = state(words, { day: daysAgo(5), todayReviewed: 4 });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = mountReview(root, {
      getState: async () => current,
      answer: async (message) => {
        const next = applyReviewAnswer(current, { id: message.id, grade: message.grade }, NOW);
        current = next.state;
        return { ok: true as const, word: next.word! };
      },
      now: () => NOW,
    });
    await view.refresh();
    expect(root.querySelector(".ilmt-review-return")).toBeTruthy();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")).toBeTruthy();
    });

    await view.refresh();
    expect(root.querySelector(".ilmt-review-return")).toBeNull();
    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 1 个");
    view.destroy();
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
