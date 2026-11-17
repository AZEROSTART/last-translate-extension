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
  LearningState,
  LearningWord,
  ReviewAnswerResponse,
} from "../../src/shared/types";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

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
  const answer = vi.fn(
    async (message: { id: string; grade: LearningGrade }): Promise<ReviewAnswerResponse> => {
      const base = words.find((item) => item.id === message.id)!;
      const dueAt = message.grade === "again" ? NOW + 10 * MINUTE : NOW + 24 * HOUR;
      return {
        ok: true as const,
        word: { ...base, box: message.grade === "again" ? 0 : 1, dueAt, updatedAt: NOW },
      };
    },
  );
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
    async (message: { id: string; grade: LearningGrade }) => {
      const next = applyReviewAnswer(
        current,
        { id: message.id, grade: message.grade },
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
  return { root, view, answer, undo, store: () => current };
}

/** An effect whose performance is observable, without any real animation. */
function stageEffect(play = vi.fn()) {
  return {
    id: "fake",
    label: "假",
    summary: "",
    reserve: { above: 0, below: 0 },
    mount: () => ({ setState: () => {}, play, destroy: () => {} }),
  } as unknown as ClaimEffect;
}

function reveal(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>(".ilmt-review-reveal")!.click();
}

function pick(root: HTMLElement, grade: "good" | "again"): void {
  root.querySelector<HTMLButtonElement>(`[data-grade="${grade}"]`)!.click();
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("buildReviewQueue", () => {
  it("queues only due words, sorted by dueAt, and can still narrow by language", () => {
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

describe("prompt", () => {
  it("shows only the word, its part of speech, the blanked sentence and 看答案", async () => {
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
    const sentence = root.querySelector(".ilmt-review-sentence");
    expect(sentence?.textContent).toContain("____");
    expect(sentence?.textContent).not.toContain("outlive");
    const blank = root.querySelector(".ilmt-review-blank");
    expect(blank?.textContent).toBe("____");
    expect(blank?.getAttribute("role")).toBe("img");
    expect(blank?.getAttribute("aria-label")).toBe("空");
    expect(root.querySelector<HTMLButtonElement>(".ilmt-review-reveal")?.textContent).toBe("看答案");

    for (const selector of [
      ".ilmt-review-option",
      ".ilmt-review-choices",
      ".ilmt-review-grades",
      ".ilmt-review-meaning",
      ".ilmt-review-gloss",
      ".ilmt-review-langs",
      ".ilmt-review-mascot",
      ".ilmt-review-next",
    ]) {
      expect(root.querySelector(selector), selector).toBeNull();
    }
    view.destroy();
  });

  it("leaves out the sentence when the word has no context", async () => {
    const { root, view } = mount([word(1, { surface: "outlive", contexts: [] })]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-sentence")).toBeNull();
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("outlive");
    expect(root.querySelector<HTMLButtonElement>(".ilmt-review-reveal")?.textContent).toBe("看答案");
    view.destroy();
  });

  it("labels the target language only when the library mixes languages", async () => {
    const single = mount([word(1)]);
    await single.view.refresh();
    expect(single.root.querySelector(".ilmt-review-lang-label")).toBeNull();
    single.view.destroy();

    const mixed = mount([
      word(2, { id: "es:actual", termLang: "es", surface: "actual", dueAt: NOW }),
      word(1, { surface: "outlive", dueAt: NOW - MINUTE }),
    ]);
    await mixed.view.refresh();
    expect(mixed.root.querySelector(".ilmt-review-lang-label")?.textContent).toBe("英语");
    mixed.view.destroy();
  });

  it("writes nothing before the answer has been asked for", async () => {
    const { root, view, answer } = mount([word(1)]);
    await view.refresh();

    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-grade")).toBeNull();
    expect(root.querySelector(".ilmt-review-next")).toBeNull();
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();
    view.destroy();
  });
});

describe("revealed", () => {
  const outlive = () =>
    word(1, {
      surface: "outlive",
      glosses: [{ lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW }],
    });

  it("opens the meaning and exactly two equal grades without writing", async () => {
    const { root, view, answer } = mount([outlive(), word(2)]);
    await view.refresh();
    reveal(root);

    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toBe("比……存在得更久");
    const grades = [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-grade")];
    expect(grades).toHaveLength(2);
    expect(grades.map((button) => button.dataset.grade)).toEqual(["good", "again"]);
    expect(grades.map((button) => button.textContent)).toEqual(["想起来了", "没想起来"]);
    expect(root.querySelector('[data-grade="hard"]')).toBeNull();
    expect(answer).not.toHaveBeenCalled();
    view.destroy();
  });

  it("drops the interval preview, the explainer and 下一张", async () => {
    const { root, view } = mount([outlive(), word(2)]);
    await view.refresh();
    reveal(root);

    expect(root.querySelector(".ilmt-review-grade-due")).toBeNull();
    expect(root.querySelector(".ilmt-review-grade-note")).toBeNull();
    expect(root.querySelector(".ilmt-review-next")).toBeNull();
    view.destroy();
  });

  it("shows one meaning, without a second language or a full sentence", async () => {
    const { root, view } = mount([
      word(1, {
        glosses: [
          { lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW },
          { lang: "es", meaning: "sobrevivir", source: "translation", at: NOW },
        ],
        glossLang: "zh",
      }),
    ]);
    await view.refresh();
    reveal(root);

    expect(root.querySelectorAll(".ilmt-review-meaning")).toHaveLength(1);
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toBe("比……存在得更久");
    expect(root.querySelector(".ilmt-review-meaning-more")).toBeNull();
    expect(root.querySelector(".ilmt-review-sentence-full")).toBeNull();
    view.destroy();
  });

  it("says when no meaning was generated and still offers both grades", async () => {
    const { root, view } = mount([word(1, { glosses: [] })]);
    await view.refresh();
    reveal(root);

    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toBe("释义还没生成");
    expect(root.querySelectorAll(".ilmt-review-grade")).toHaveLength(2);
    view.destroy();
  });

  it("writes 想起来了 once and moves straight to the next prompt", async () => {
    const { root, view, answer } = mount([word(1), word(2)]);
    await view.refresh();
    reveal(root);
    pick(root, "good");

    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "review-answer", id: "en:word1", grade: "good" }),
    );
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();
    expect(root.querySelector(".ilmt-review-reveal")?.textContent).toBe("看答案");
    expect(document.activeElement).toBe(root.querySelector(".ilmt-review-reveal"));
    expect(root.querySelector(".ilmt-review-next")).toBeNull();
    const receipt = root.querySelector(".ilmt-review-receipt")!;
    expect(receipt.firstElementChild?.textContent).toBe("word1 · 词1 · 明天再见");
    expect(receipt.textContent).toContain("撤销");
    view.destroy();
  });

  it("keeps the card and lets the user retry when the write fails", async () => {
    const { root, view, answer } = mount([word(1), word(2)]);
    await view.refresh();
    answer.mockImplementationOnce(
      async () => ({ ok: false }) as unknown as { ok: true; word: LearningWord },
    );
    reveal(root);
    pick(root, "good");

    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(root.querySelector(".ilmt-review-error")?.textContent).toBe("没写进去 · 再点一次");
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toBe("词1");
    expect(root.querySelectorAll(".ilmt-review-grade")).toHaveLength(2);
    expect(root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.disabled).toBe(false);
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 2");
    expect(root.querySelector(".ilmt-review-next")).toBeNull();

    pick(root, "good");
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });
    expect(root.querySelector(".ilmt-review-error")).toBeNull();
    view.destroy();
  });

  it("does not rebuild the card when a refresh lands while revealed", async () => {
    const { root, view, answer } = mount([word(1), word(2)]);
    await view.refresh();
    reveal(root);

    await view.refresh();

    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toBe("词1");
    expect(answer).not.toHaveBeenCalled();
    view.destroy();
  });

  it("ends without writing from the revealed card", async () => {
    const { root, view, answer } = mount([word(1), word(2)]);
    await view.refresh();
    reveal(root);
    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(root.textContent).toContain("还有 2 个到期");
    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-receipt")).toBeNull();
    view.destroy();
  });
});

describe("lesson", () => {
  const sceneWord = () =>
    word(1, {
      surface: "outlive",
      glosses: [{ lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW }],
    });

  it("keeps the missed word, writes once, and shows the picture and 下一张", async () => {
    const mnemonic = vi.fn().mockResolvedValue({
      ok: true as const,
      mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
    });
    const { root, view, answer } = mount([sceneWord()], {
      mnemonic,
      effect: () => stageEffect(),
    });
    await view.refresh();
    reveal(root);
    pick(root, "again");

    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "review-answer", id: "en:word1", grade: "again" }),
    );
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("outlive");
    expect(root.querySelector(".ilmt-review-lesson")).toBeTruthy();
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toBe("比……存在得更久");
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-scene-caption")?.textContent).toBe("猫把词抱进怀里");
    });
    expect(root.querySelector(".ilmt-review-scene-replay")).toBeNull();
    expect(root.querySelector(".ilmt-review-next")?.textContent).toBe("下一张");
    expect(root.querySelector(".ilmt-review-receipt")).toBeNull();
    expect(mnemonic).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("turns the page without writing again", async () => {
    const { root, view, answer } = mountStored([word(1), word(2)], {
      mnemonic: vi.fn().mockResolvedValue({
        ok: true as const,
        mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
      }),
      effect: () => stageEffect(),
    });
    await view.refresh();
    reveal(root);
    pick(root, "again");
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-lesson")).toBeTruthy());

    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();
    expect(document.activeElement).toBe(root.querySelector(".ilmt-review-reveal"));
    expect(root.querySelector(".ilmt-review-receipt")?.firstElementChild?.textContent).toBe(
      "word1 · 词1 · 10 分钟后再见",
    );
    view.destroy();
  });

  it("never asks for a picture on the 想起来了 path", async () => {
    const mnemonic = vi.fn().mockResolvedValue({
      ok: true as const,
      mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
    });
    const { root, view } = mount([sceneWord(), word(2)], { mnemonic });
    await view.refresh();
    reveal(root);
    pick(root, "good");

    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-receipt")).toBeTruthy());
    expect(mnemonic).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-scene")).toBeNull();
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
    reveal(root);
    pick(root, "again");

    await vi.waitFor(() =>
      expect(root.querySelector(".ilmt-review-scene-caption")?.textContent).toBe(
        "地鼠把词拖进洞里",
      ),
    );
    expect(mnemonic).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledTimes(1);
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
    reveal(root);
    pick(root, "again");

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

  it("keeps 下一张 available while the picture is still loading", async () => {
    const mnemonic = vi.fn(() => new Promise<never>(() => {}));
    const { root, view, answer } = mount([sceneWord(), word(2)], {
      mnemonic,
      effect: () => stageEffect(),
    });
    await view.refresh();
    reveal(root);
    pick(root, "again");

    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-lesson")).toBeTruthy());
    expect(root.querySelector(".ilmt-review-scene-caption")?.textContent).toContain("想一个画面");
    expect(root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.disabled).toBe(false);

    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });
    expect(answer).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("does not rebuild the lesson when a refresh lands", async () => {
    const { root, view, answer } = mountStored([word(1), word(2)], {
      mnemonic: vi.fn().mockResolvedValue({
        ok: true as const,
        mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
      }),
      effect: () => stageEffect(),
    });
    await view.refresh();
    reveal(root);
    pick(root, "again");
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-lesson")).toBeTruthy());

    await view.refresh();

    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    expect(root.querySelector(".ilmt-review-lesson")).toBeTruthy();
    expect(answer).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("keeps the lesson usable when the scene request throws", async () => {
    const mnemonic = vi.fn().mockRejectedValue(new Error("offline"));
    const { root, view } = mount([sceneWord()], {
      mnemonic,
      effect: () => stageEffect(),
    });
    await view.refresh();
    reveal(root);
    pick(root, "again");

    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-scene-retry")).toBeTruthy());
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toBe("比……存在得更久");
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
    view.destroy();
  });
});

describe("library shelf and the three endings", () => {
  it("guides a brand-new library instead of reporting three zeros", async () => {
    const { root, view } = mount([]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("还没有收录的词");
    expect(root.textContent).toContain("浅灰");
    expect(root.textContent).toContain("⌥A");
    expect(root.textContent).not.toContain("今天已复习");
    expect(root.querySelector(".ilmt-review-shelf")).toBeNull();
    view.destroy();
  });

  it("keeps the library size above everything, counting mastered words", async () => {
    const words = [word(1), word(2), word(3, { status: "mastered", box: 5, dueAt: null })];
    const { root, view } = mount(words);
    await view.refresh();

    const shelf = root.querySelector<HTMLElement>(".ilmt-review-shelf");
    expect(shelf?.textContent).toBe("已收录 3 个 · 已毕业 1 个");
    const review = root.querySelector(".ilmt-review")!;
    expect(review.firstElementChild).toBe(shelf);
    view.destroy();
  });

  it("drops the graduated part of the shelf when nothing has graduated", async () => {
    const { root, view } = mount([word(1), word(2), word(3)]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 3 个");
    expect(root.textContent).not.toContain("已毕业");
    view.destroy();
  });

  it("keeps the shelf on the card and on both finish pages", async () => {
    const words = [word(1), word(2), word(3)];

    const card = mount(words);
    await card.view.refresh();
    expect(card.root.querySelector(".ilmt-review-card")).toBeTruthy();
    expect(card.root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 3 个");
    card.view.destroy();

    const early = mount(words);
    await early.view.refresh();
    early.root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(early.root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(early.root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 3 个");
    early.view.destroy();

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

    reveal(root);
    pick(root, "good");
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });
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
    view.destroy();
  });

  it("counts tomorrow's card in the all-done state", async () => {
    const { root, view } = mount([word(1, { dueAt: NOW + HOUR })]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("今天没有要复习的词");
    expect(root.textContent).toContain("明日还有 1 个");
    expect(root.querySelector(".ilmt-review-continue")).toBeNull();
    view.destroy();
  });

  it("omits the summary line when nothing was answered and nothing is due", async () => {
    const { root, view } = mount([word(1, { dueAt: NOW + 48 * HOUR })]);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-done-summary")).toBeNull();
    expect(root.textContent).not.toContain("明日还有 0 个");
    view.destroy();
  });

  it("closes the round with how many cards passed, naming only the ones missed", async () => {
    const { root, view } = mountStored([word(1), word(2), word(3)], {
      mnemonic: vi.fn().mockResolvedValue({
        ok: true as const,
        mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
      }),
      effect: () => stageEffect(),
    });
    await view.refresh();

    reveal(root);
    pick(root, "good");
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });
    reveal(root);
    pick(root, "good");
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word3");
    });
    reveal(root);
    pick(root, "again");
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-next")).toBeTruthy());
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("3 个都过完了");
    });
    expect(root.querySelector(".ilmt-review-done-summary")?.textContent).toBe("1 个没想起来");
    expect(root.textContent).not.toContain("认识");
    expect(root.textContent).not.toContain("明日还有");
    expect(root.querySelector(".ilmt-review-done-today")?.textContent).toBe("今天已复习 0 个");
    view.destroy();
  });

  it("says nothing about missed cards when every card was remembered", async () => {
    const { root, view } = mountStored([word(1), word(2)]);
    await view.refresh();

    reveal(root);
    pick(root, "good");
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });
    reveal(root);
    pick(root, "good");

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("2 个都过完了");
    });
    expect(root.querySelector(".ilmt-review-done-summary")).toBeNull();
    expect(root.textContent).not.toContain("没想起来");
    view.destroy();
  });
});

describe("receipt and undo", () => {
  async function commitFirst(root: HTMLElement): Promise<void> {
    reveal(root);
    pick(root, "good");
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-receipt")).toBeTruthy());
  }

  it("says what the word was, what it means, and when it returns", async () => {
    const { root, view, undo } = mountStored([word(1), word(2)]);
    await view.refresh();
    await commitFirst(root);

    const receipt = root.querySelector<HTMLElement>(".ilmt-review-receipt")!;
    expect(receipt.textContent).toContain("word1");
    expect(receipt.textContent).toContain("词1");
    expect(receipt.textContent).toContain("明天再见");
    expect(receipt.textContent).not.toContain("已记录");
    expect(receipt.getAttribute("role")).toBe("status");
    expect(receipt.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")?.textContent).toBe(
      "撤销",
    );
    expect(undo).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
    view.destroy();
  });

  it("undoes once, rolls the box back and returns focus to a prompt card", async () => {
    const { root, view, answer, undo, store } = mountStored([word(1), word(2)]);
    await view.refresh();
    await commitFirst(root);
    expect(store().words[0].box).toBe(1);

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")).toBeNull();
    });
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 2");
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith({ type: "review-undo", id: "en:word1" });
    expect(store().words[0].box).toBe(0);
    expect(store().words[0].dueAt).toBe(NOW - HOUR);
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();
    expect(root.querySelector(".ilmt-review-reveal")?.textContent).toBe("看答案");
    expect(root.querySelector(".ilmt-review-grade")).toBeNull();
    expect(document.activeElement).toBe(root.querySelector(".ilmt-review-card"));
    expect(answer).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("brings a missed card back to its prompt with the same box and due time", async () => {
    const { root, view, store } = mountStored([word(1), word(2)], {
      mnemonic: vi.fn().mockResolvedValue({
        ok: true as const,
        mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
      }),
      effect: () => stageEffect(),
    });
    await view.refresh();
    reveal(root);
    pick(root, "again");
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-next")).toBeTruthy());
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")?.textContent).toContain("10 分钟后再见");
    });
    expect(store().words[0].dueAt).toBe(NOW + 10 * MINUTE);

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")).toBeNull();
    });
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    });
    expect(store().words[0].box).toBe(0);
    expect(store().words[0].dueAt).toBe(NOW - HOUR);
    expect(root.querySelector(".ilmt-review-reveal")?.textContent).toBe("看答案");
    view.destroy();
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
    view.destroy();
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
    view.destroy();
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
      view.destroy();
    },
  );

  it("undoes from the finish page without resetting the round", async () => {
    const words = [word(1), word(2), word(3)];
    const { root, view } = mountStored(words);
    await view.refresh();

    await commitFirst(root);

    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("本轮先到这");
    });
    expect(root.querySelector(".ilmt-review-receipt")?.textContent).toContain("明天再见");

    root.querySelector<HTMLButtonElement>(".ilmt-review-receipt-undo")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done")).toBeNull();
    });
    expect(root.querySelector(".ilmt-review-receipt")).toBeNull();
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 3");
    expect(root.querySelector(".ilmt-review-reveal")?.textContent).toBe("看答案");
    view.destroy();
  });
});

describe("graduation send-off", () => {
  async function finishWith(
    root: HTMLElement,
    clicks: number,
    names: string[] = [],
  ): Promise<void> {
    for (let i = 0; i < clicks; i++) {
      reveal(root);
      pick(root, "good");
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

    reveal(root);
    pick(root, "good");
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

    reveal(root);
    pick(root, "good");
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-receipt")).toBeTruthy();
    });

    await view.refresh();
    expect(root.querySelector(".ilmt-review-return")).toBeNull();
    expect(root.querySelector(".ilmt-review-shelf")?.textContent).toBe("已收录 1 个");
    view.destroy();
  });
});

describe("one write per card", () => {
  it("writes 想起来了 once and 没想起来 once across two cards", async () => {
    const { root, view, answer } = mountStored([word(1), word(2)], {
      mnemonic: vi.fn().mockResolvedValue({
        ok: true as const,
        mnemonic: { caption: "猫把词抱进怀里", lang: "zh", at: NOW },
      }),
      effect: () => stageEffect(),
    });
    await view.refresh();

    reveal(root);
    pick(root, "good");
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word2");
    });

    reveal(root);
    pick(root, "again");
    await vi.waitFor(() => expect(root.querySelector(".ilmt-review-next")).toBeTruthy());
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    expect(answer.mock.calls.map(([message]) => message.grade)).toEqual(["good", "again"]);
    expect(answer).toHaveBeenCalledTimes(2);
    view.destroy();
  });
});
