import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReviewQueue, mountReview } from "../../src/panel/review";
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

  it("sends the chosen grade and advances to the next card", async () => {
    const words = [word(1), word(2)];
    const { root, view, answer } = mount(words);
    await view.refresh();

    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 2");

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({ type: "review-answer", id: "en:word1", grade: "good" }),
      );
    });
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
    });
  });

  it("shows the finish card when the queue is empty", async () => {
    const { root, view } = mount([]);
    await view.refresh();

    expect(root.textContent).toContain("今天没有要复习的词");
    expect(root.textContent).toContain("本轮");
  });
});

describe("spot check integration", () => {
  it("turns the third review into a four-way question and sends the spot result", async () => {
    const target = word(1, {
      surface: "outlive",
      checksSinceSpot: 2,
      dueAt: NOW - 5 * HOUR,
      glosses: [{ lang: "zh", meaning: "比…活得久", source: "translation", at: NOW }],
    });
    const words = [
      target,
      word(2, { glosses: [{ lang: "zh", meaning: "实际的", source: "translation", at: NOW }] }),
      word(3, { glosses: [{ lang: "zh", meaning: "当前的", source: "translation", at: NOW }] }),
      word(4, { glosses: [{ lang: "zh", meaning: "生存", source: "translation", at: NOW }] }),
    ];
    const { root, view, answer } = mount(words);
    await view.refresh();

    const options = [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")];
    expect(options).toHaveLength(4);
    options.find((option) => option.textContent === "比…活得久")!.click();

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

  it("shows the correct meaning after a wrong answer and waits for 下一张", async () => {
    const target = word(1, {
      surface: "outlive",
      checksSinceSpot: 2,
      dueAt: NOW - 5 * HOUR,
      glosses: [{ lang: "zh", meaning: "比…活得久", source: "translation", at: NOW }],
    });
    const words = [
      target,
      word(2, { glosses: [{ lang: "zh", meaning: "实际的", source: "translation", at: NOW }] }),
      word(3, { glosses: [{ lang: "zh", meaning: "当前的", source: "translation", at: NOW }] }),
      word(4, { glosses: [{ lang: "zh", meaning: "生存", source: "translation", at: NOW }] }),
    ];
    const { root, view, answer } = mount(words);
    await view.refresh();

    const options = [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")];
    options.find((option) => option.textContent === "实际的")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({ id: "en:word1", grade: "again", spot: true, spotCorrect: false }),
      );
    });
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-spot-note")?.textContent).toContain("比…活得久");
    });
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
  });
});
