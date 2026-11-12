import { describe, expect, it } from "vitest";
import { buildSpotQuestion, shouldSpotCheck } from "../../src/shared/spot";
import type { LearningWord } from "../../src/shared/types";

const NOW = 1_700_000_000_000;

function word(index: number, meaning: string, over: Partial<LearningWord> = {}): LearningWord {
  return {
    id: `en:word${index}`,
    termLang: "en",
    surface: `word${index}`,
    glosses: [{ lang: "zh", meaning, source: "translation", at: NOW }],
    glossLang: "zh",
    contexts: [],
    status: "learning",
    box: 0,
    dueAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    reviews: [],
    reviewsCount: 0,
    correctCount: 0,
    checksSinceSpot: 0,
    ...over,
  };
}

describe("shouldSpotCheck", () => {
  it("asks on every third review and never right after a spot check", () => {
    expect(shouldSpotCheck(word(1, "甲", { checksSinceSpot: 2 }))).toBe(true);
    expect(shouldSpotCheck(word(1, "甲", { checksSinceSpot: 1 }))).toBe(false);
    expect(shouldSpotCheck(word(1, "甲", { checksSinceSpot: 0 }))).toBe(false);
  });
});

describe("buildSpotQuestion", () => {
  const target = word(1, "比…活得久");
  const pool = [word(2, "实际的"), word(3, "当前的"), word(4, "生存"), word(5, "比…活得久")];

  it("offers four distinct meanings including the answer", () => {
    const question = buildSpotQuestion(target, pool, "zh", 7)!;
    expect(question.options).toHaveLength(4);
    expect(new Set(question.options).size).toBe(4);
    expect(question.options[question.answer]).toBe("比…活得久");
  });

  it("is deterministic for a given seed", () => {
    const a = buildSpotQuestion(target, pool, "zh", 11)!;
    const b = buildSpotQuestion(target, pool, "zh", 11)!;
    expect(b).toEqual(a);
  });

  it("returns null when the pool is too small", () => {
    expect(buildSpotQuestion(target, [], "zh", 1)).toBeNull();
    expect(buildSpotQuestion(target, [word(2, "实际的")], "zh", 1)).toBeNull();
  });

  it("ignores distractors from another answer language or the same meaning", () => {
    const mixed = [
      word(2, "实际的"),
      word(3, "当前的", { glosses: [{ lang: "es", meaning: "actual", source: "translation", at: NOW }] }),
      word(4, "比…活得久"),
      word(5, "生存"),
      word(6, "延伸"),
    ];
    const question = buildSpotQuestion(target, mixed, "zh", 3)!;
    expect(question.options).toContain("实际的");
    expect(question.options).toContain("生存");
    expect(question.options).not.toContain("actual");
    expect(new Set(question.options).size).toBe(4);
  });

  it("returns null without an answer in the requested language", () => {
    expect(buildSpotQuestion(target, pool, "es", 1)).toBeNull();
  });
});
