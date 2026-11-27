import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_WORDS,
  UNDO_WINDOW_MS,
  applyReviewAnswer,
  daysSinceDay,
  deleteWord,
  emptyLearningState,
  getLearning,
  localDay,
  mergeLearnedWord,
  parseLearningState,
  primaryMeaning,
  resetWord,
  safeHttpUrl,
  saveLearning,
  undoReviewAnswer,
  updateWordMeaning,
  wordId,
} from "../../src/shared/learning-storage";
import type { LearnWordMessage, LearningState, LearningWord } from "../../src/shared/types";

const NOW = 1_700_000_000_000;

function learn(over: Partial<LearnWordMessage> = {}): LearnWordMessage {
  return {
    type: "learn-word",
    surface: "outlive",
    termLang: "en",
    glossLang: "zh",
    meaning: "比…活得久",
    sentence: "Small tools often outlive their rivals.",
    pageUrl: "https://example.test/a",
    ...over,
  };
}

function makeWord(i: number, over: Partial<LearningWord> = {}): LearningWord {
  return {
    id: `en:word${i}`,
    termLang: "en",
    surface: `word${i}`,
    glosses: [{ lang: "zh", meaning: `词${i}`, source: "translation", at: NOW }],
    glossLang: "zh",
    contexts: [],
    status: "learning",
    box: 0,
    dueAt: NOW,
    createdAt: NOW,
    updatedAt: NOW + i,
    lastSeenAt: NOW,
    reviews: [],
    reviewsCount: 0,
    correctCount: 0,
    checksSinceSpot: 0,
    ...over,
  };
}

beforeEach(() => chrome.storage.local.clear());

describe("parseLearningState", () => {
  it("returns an empty state for missing or corrupt data", () => {
    expect(parseLearningState(undefined).words).toEqual([]);
    expect(parseLearningState({ words: "nope" }).words).toEqual([]);
    expect(parseLearningState({ version: 99, words: [] }).version).toBe(1);
  });

  it("keeps a stored mnemonic and drops broken ones", () => {
    const base = {
      id: "en:outlive",
      termLang: "en",
      surface: "outlive",
      glossLang: "zh-CN",
      glosses: [{ lang: "zh-CN", meaning: "比…久", source: "translation", at: 1 }],
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
    };

    const kept = parseLearningState({
      words: [{ ...base, mnemonic: { caption: "猫把词藏进怀里", lang: "zh-CN", at: 7 } }],
    });
    expect(kept.words[0].mnemonic).toEqual({ caption: "猫把词藏进怀里", lang: "zh-CN", at: 7 });

    for (const mnemonic of [null, "nope", {}, { caption: "" }, { caption: 42 }]) {
      const parsed = parseLearningState({ words: [{ ...base, mnemonic }] });
      expect(parsed.words[0].mnemonic).toBeUndefined();
    }
  });

  it("drops malformed words but keeps valid ones", () => {
    const state = parseLearningState({
      version: 1,
      words: [makeWord(1), { id: 5, surface: null }, { ...makeWord(2), box: "x" }],
      stats: { day: 7, todayReviewed: "yes" },
      updatedAt: NOW,
    });
    expect(state.words.map((w) => w.id)).toEqual(["en:word1", "en:word2"]);
    expect(state.words[1].box).toBe(0);
    expect(state.stats.day).toBe("");
    expect(state.stats.todayReviewed).toBe(0);
  });
});

describe("mergeLearnedWord", () => {
  it("creates a card due in ten minutes", () => {
    const { state, created, word } = mergeLearnedWord(emptyLearningState(), learn(), NOW);
    expect(created).toBe(true);
    expect(word).toMatchObject({
      id: "en:outlive",
      status: "learning",
      box: 0,
      dueAt: NOW + 10 * 60_000,
      reviewsCount: 0,
      checksSinceSpot: 0,
    });
    expect(word.glosses).toEqual([
      { lang: "zh", meaning: "比…活得久", source: "translation", at: NOW },
    ]);
    expect(state.words).toHaveLength(1);
  });

  it("keeps one card per language and surface", () => {
    const s0 = emptyLearningState();
    const a = mergeLearnedWord(s0, learn({ surface: "Actual", termLang: "en", meaning: "实际的" }), NOW);
    const b = mergeLearnedWord(
      a.state,
      learn({ surface: "actual", termLang: "es", meaning: "当前的", sentence: "y" }),
      NOW,
    );
    expect(b.state.words.map((w) => w.id)).toEqual(["en:actual", "es:actual"]);
    expect(b.created).toBe(true);
  });

  it("normalizes whitespace and case in the id", () => {
    expect(wordId("en", "  Actual\tWord  ")).toBe("en:actual word");
  });

  it("does not reset scheduling when a word is seen again", () => {
    const first = mergeLearnedWord(emptyLearningState(), learn({ sentence: "s1" }), NOW);
    const reviewed = applyReviewAnswer(first.state, { id: "en:outlive", grade: "good" }, NOW).state;
    const again = mergeLearnedWord(
      reviewed,
      learn({ sentence: "s2", glosses: { es: "sobrevivir" } }),
      NOW + 1000,
    ).state;
    const w = again.words[0];
    expect(w.box).toBe(1);
    expect(w.glosses.map((g) => g.lang)).toEqual(["zh", "es"]);
    expect(w.contexts.map((c) => c.sentence)).toEqual(["s1", "s2"]);
    expect(w.lastSeenAt).toBe(NOW + 1000);
  });

  it("keeps at most three contexts and ten reviews", () => {
    let state = mergeLearnedWord(emptyLearningState(), learn({ sentence: "s1" }), NOW).state;
    for (const sentence of ["s2", "s3", "s4", "s5"]) {
      state = mergeLearnedWord(state, learn({ sentence }), NOW).state;
    }
    expect(state.words[0].contexts.map((c) => c.sentence)).toEqual(["s3", "s4", "s5"]);

    for (let i = 0; i < 11; i++) {
      state = applyReviewAnswer(state, { id: "en:outlive", grade: "good" }, NOW + i).state;
    }
    expect(state.words[0].reviews).toHaveLength(10);
    expect(state.words[0].reviewsCount).toBe(11);
  });

  it("does not overwrite the mascot that claimed the word", () => {
    const first = mergeLearnedWord(emptyLearningState(), learn({ mascotId: "gopher" }), NOW).state;
    const again = mergeLearnedWord(first, learn({ mascotId: "cat", sentence: "s2" }), NOW).state;
    expect(again.words[0].mascotId).toBe("gopher");
  });
});

describe("applyReviewAnswer", () => {
  it("counts correct answers and resets the spot-check counter", () => {
    let state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    state = applyReviewAnswer(
      state,
      { id: "en:outlive", grade: "good", spot: true, spotCorrect: true, glossLang: "es" },
      NOW + 10,
    ).state;
    const w = state.words[0];
    expect(w.correctCount).toBe(1);
    expect(w.checksSinceSpot).toBe(0);
    expect(w.reviews[0]).toMatchObject({ spot: true, spotCorrect: true, glossLang: "es", box: 1 });
  });

  it("increments the spot counter on a plain review", () => {
    let state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    state = applyReviewAnswer(state, { id: "en:outlive", grade: "hard" }, NOW + 10).state;
    expect(state.words[0].checksSinceSpot).toBe(1);
    expect(state.words[0].correctCount).toBe(0);
  });

  it("returns a null word and unchanged state for an unknown id", () => {
    const state = emptyLearningState();
    const result = applyReviewAnswer(state, { id: "en:missing", grade: "good" }, NOW);
    expect(result.word).toBeNull();
    expect(result.state).toBe(state);
  });
});

describe("review snapshots and undo", () => {
  function snapshotOf(word: LearningWord) {
    return {
      box: word.box,
      dueAt: word.dueAt,
      status: word.status,
      reviewsCount: word.reviewsCount,
      correctCount: word.correctCount,
      checksSinceSpot: word.checksSinceSpot,
    };
  }

  it("stores the pre-review state and keeps only the newest snapshot", () => {
    let state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    const before = snapshotOf(state.words[0]);

    state = applyReviewAnswer(state, { id: "en:outlive", grade: "good" }, NOW + 1000).state;
    expect(state.words[0].reviews.at(-1)?.before).toEqual(before);

    const afterFirst = snapshotOf(state.words[0]);
    state = applyReviewAnswer(state, { id: "en:outlive", grade: "hard" }, NOW + 2000).state;

    const reviews = state.words[0].reviews;
    expect(reviews).toHaveLength(2);
    expect(reviews[0].before).toBeUndefined();
    expect(reviews[1].before).toEqual(afterFirst);
    expect(reviews.filter((entry) => entry.before)).toHaveLength(1);
  });

  it("restores every scheduling field and the counts", () => {
    let state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    const before = snapshotOf(state.words[0]);
    state = applyReviewAnswer(
      state,
      { id: "en:outlive", grade: "good", spot: true, spotCorrect: true },
      NOW + 1000,
    ).state;
    expect(state.stats.todayReviewed).toBe(1);

    const undone = undoReviewAnswer(state, { id: "en:outlive" }, NOW + 2000);

    expect(undone.reason).toBeUndefined();
    expect(undone.word).not.toBeNull();
    const word = undone.state.words[0];
    expect(snapshotOf(word)).toEqual(before);
    expect(word.reviews).toHaveLength(0);
    expect(undone.state.stats.todayReviewed).toBe(0);
  });

  it("refuses an unknown word and leaves the state untouched", () => {
    const state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    const result = undoReviewAnswer(state, { id: "en:missing" }, NOW);

    expect(result).toMatchObject({ word: null, reason: "unknown-word" });
    expect(result.state).toBe(state);
  });

  it("refuses a word with no reviews at all", () => {
    const state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    const result = undoReviewAnswer(state, { id: "en:outlive" }, NOW);

    expect(result).toMatchObject({ word: null, reason: "not-latest" });
    expect(result.state).toBe(state);
  });

  it("refuses an entry written before snapshots existed", () => {
    const legacy = makeWord(1, {
      reviews: [{ at: NOW, grade: "good", box: 1 }],
      reviewsCount: 1,
      box: 1,
      dueAt: NOW + 24 * 60 * 60 * 1000,
    });
    const state: LearningState = {
      version: 1,
      words: [legacy],
      stats: { day: "", todayReviewed: 0 },
      updatedAt: NOW,
    };

    const result = undoReviewAnswer(state, { id: legacy.id }, NOW);

    expect(result).toMatchObject({ word: null, reason: "unsupported" });
    expect(result.state).toBe(state);
  });

  it("refuses an entry older than the ten-minute window", () => {
    let state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    state = applyReviewAnswer(state, { id: "en:outlive", grade: "good" }, NOW).state;

    const fresh = undoReviewAnswer(state, { id: "en:outlive" }, NOW + UNDO_WINDOW_MS);
    expect(fresh.word).not.toBeNull();

    const stale = undoReviewAnswer(state, { id: "en:outlive" }, NOW + UNDO_WINDOW_MS + 1);
    expect(stale).toMatchObject({ word: null, reason: "too-old" });
    expect(stale.state).toBe(state);
  });

  it("parses a snapshot, and only drops the snapshot when it is malformed", () => {
    const before = snapshotOf(makeWord(2));
    const entry = { at: NOW, grade: "good" as const, box: 1, before };

    const kept = parseLearningState({
      words: [{ ...makeWord(1), reviews: [entry] }],
    });
    expect(kept.words[0].reviews[0].before).toEqual(before);

    const broken = parseLearningState({
      words: [{ ...makeWord(1), reviews: [{ ...entry, before: { ...before, box: "1" } }] }],
    });
    expect(broken.words[0].reviews).toHaveLength(1);
    expect(broken.words[0].reviews[0].before).toBeUndefined();

    const legacy = parseLearningState({
      words: [{ ...makeWord(1), reviews: [{ at: NOW, grade: "good", box: 1 }] }],
    });
    expect(legacy.words[0].reviews).toHaveLength(1);
    expect(legacy.words[0].reviews[0].before).toBeUndefined();
    expect(legacy.words[0].id).toBe("en:word1");
  });
});

describe("local days", () => {
  // Local wall-clock time, so the assertions hold in any time zone.
  const at = new Date(2026, 10, 16, 9, 30).getTime();

  it("names the local calendar day", () => {
    expect(localDay(at)).toBe("2026-11-16");
    expect(localDay(new Date(2026, 0, 2, 0, 0).getTime())).toBe("2026-01-02");
  });

  it("counts whole days since a local date", () => {
    expect(daysSinceDay("2026-11-16", at)).toBe(0);
    expect(daysSinceDay("2026-11-15", at)).toBe(1);
    expect(daysSinceDay("2026-11-17", at)).toBe(-1);
    // Across a month boundary and across a year boundary.
    expect(daysSinceDay("2026-10-31", at)).toBe(16);
    expect(daysSinceDay("2025-12-31", at)).toBe(320);
  });

  it("returns null when the day cannot be trusted", () => {
    expect(daysSinceDay("", at)).toBeNull();
    expect(daysSinceDay("2026-13-40", at)).toBeNull();
    expect(daysSinceDay("2026-02-30", at)).toBeNull();
    expect(daysSinceDay("2026-11-16T00:00", at)).toBeNull();
  });
});

describe("pruning", () => {
  it("drops the oldest mastered word before any learning word", () => {
    const mastered = makeWord(0, { status: "mastered", dueAt: null, updatedAt: NOW - 999 });
    const words: LearningWord[] = [mastered];
    for (let i = 1; i < MAX_WORDS; i++) words.push(makeWord(i));
    const state: LearningState = {
      version: 1,
      words,
      stats: { day: "", todayReviewed: 0 },
      updatedAt: NOW,
    };

    const next = mergeLearnedWord(state, learn({ surface: "newcomer" }), NOW).state;
    expect(next.words).toHaveLength(MAX_WORDS);
    expect(next.words.some((w) => w.id === mastered.id)).toBe(false);
    expect(next.words.some((w) => w.id === "en:newcomer")).toBe(true);
  });
});

describe("storage", () => {
  it("round-trips through chrome.storage and tolerates corruption", async () => {
    const state = mergeLearnedWord(emptyLearningState(), learn(), NOW).state;
    await saveLearning(state);
    expect((await getLearning()).words).toHaveLength(1);

    await chrome.storage.local.set({ learning: { words: "broken" } });
    expect((await getLearning()).words).toEqual([]);
  });
});

describe("primaryMeaning and URL helpers", () => {
  it("prefers the requested language, then the word's own, then the first gloss", () => {
    const entry = makeWord(1, {
      glossLang: "ja",
      glosses: [
        { lang: "zh", meaning: "中文义", source: "translation", at: NOW },
        { lang: "ja", meaning: "日语义", source: "translation", at: NOW },
      ],
    });
    expect(primaryMeaning(entry, "zh")).toBe("中文义");
    expect(primaryMeaning(entry, "fr")).toBe("日语义");
    expect(primaryMeaning({ ...entry, glossLang: "de" })).toBe("中文义");
    expect(primaryMeaning({ ...entry, glosses: [] })).toBe("");
  });

  it("accepts only absolute http(s) URLs", () => {
    expect(safeHttpUrl(" https://example.test/a ")).toBe("https://example.test/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("/relative")).toBeNull();
  });
});

describe("updateWordMeaning", () => {
  it("trims the edit and updates the preferred gloss in place", () => {
    const state: LearningState = { ...emptyLearningState(), words: [makeWord(1, {
      glosses: [
        { lang: "zh", meaning: "旧义", source: "translation", at: NOW },
        { lang: "es", meaning: "sobrevivir", source: "translation", at: NOW },
      ],
    })] };
    const result = updateWordMeaning(
      state,
      { id: "en:word1", meaning: "  新义  ", glossLang: "zh" },
      NOW + 50,
    );

    expect(result.word?.glosses).toEqual([
      { lang: "zh", meaning: "新义", source: "translation", at: NOW },
      { lang: "es", meaning: "sobrevivir", source: "translation", at: NOW },
    ]);
    expect(result.word?.updatedAt).toBe(NOW + 50);
    expect(result.state.updatedAt).toBe(NOW + 50);
    expect(result.state.words[0]).toBe(result.word);
  });

  it("prepends a missing preferred language as a lookup gloss", () => {
    const state = { ...emptyLearningState(), words: [makeWord(1)] };
    const result = updateWordMeaning(
      state,
      { id: "en:word1", meaning: "sobrevivir", glossLang: "es" },
      NOW + 2,
    );
    expect(result.word?.glosses[0]).toEqual({
      lang: "es",
      meaning: "sobrevivir",
      source: "lookup",
      at: NOW + 2,
    });
    expect(result.word?.glosses[1].lang).toBe("zh");
  });

  it("falls back to the word's language, then the first gloss, then a new gloss", () => {
    const own = updateWordMeaning(
      { ...emptyLearningState(), words: [makeWord(1)] },
      { id: "en:word1", meaning: "自己的语言" },
      NOW + 3,
    );
    expect(own.word?.glosses[0]).toMatchObject({ lang: "zh", meaning: "自己的语言" });

    const first = updateWordMeaning(
      {
        ...emptyLearningState(),
        words: [makeWord(1, {
          glossLang: "de",
          glosses: [{ lang: "es", meaning: "西语", source: "translation", at: NOW }],
        })],
      },
      { id: "en:word1", meaning: "第一个" },
      NOW + 4,
    );
    expect(first.word?.glosses[0]).toMatchObject({ lang: "es", meaning: "第一个" });

    const fresh = updateWordMeaning(
      { ...emptyLearningState(), words: [makeWord(1, { glosses: [] })] },
      { id: "en:word1", meaning: "新释义" },
      NOW + 5,
    );
    expect(fresh.word?.glosses).toEqual([
      { lang: "zh", meaning: "新释义", source: "lookup", at: NOW + 5 },
    ]);
  });

  it("rejects an empty meaning or an unknown id without touching state", () => {
    const state = { ...emptyLearningState(), words: [makeWord(1)] };
    expect(updateWordMeaning(state, { id: "en:word1", meaning: "   " }, NOW)).toEqual({
      state,
      word: null,
    });
    expect(updateWordMeaning(state, { id: "en:missing", meaning: "x" }, NOW)).toEqual({
      state,
      word: null,
    });
  });
});

describe("resetWord", () => {
  it("makes a graduated word due again and keeps everything the user invested", () => {
    const reviews = [{ at: NOW, grade: "good" as const, box: 5 }];
    const state: LearningState = {
      ...emptyLearningState(),
      words: [makeWord(1, {
        status: "mastered",
        box: 5,
        dueAt: null,
        mascotId: "cat-hoard",
        mnemonic: { caption: "猫把它抱进怀里", lang: "zh", at: NOW },
        reviews,
        contexts: [{ sentence: "A sentence.", pageUrl: "https://x.test", at: NOW }],
        createdAt: NOW - 100,
      })],
      updatedAt: NOW,
    };

    const result = resetWord(state, "en:word1", NOW + 500);
    const word = result.word!;

    expect(word).toMatchObject({
      id: "en:word1",
      status: "learning",
      box: 0,
      dueAt: NOW + 500,
      updatedAt: NOW + 500,
      mascotId: "cat-hoard",
      createdAt: NOW - 100,
    });
    expect(word.glosses).toEqual(state.words[0].glosses);
    expect(word.contexts).toEqual(state.words[0].contexts);
    expect(word.mnemonic).toEqual(state.words[0].mnemonic);
    expect(word.reviews).toEqual(reviews);
    expect(result.state.updatedAt).toBe(NOW + 500);
    expect(result.state.words[0]).toBe(word);
  });

  it("leaves an unknown id alone", () => {
    const state = { ...emptyLearningState(), words: [makeWord(1)] };
    expect(resetWord(state, "en:missing", NOW)).toEqual({ state, word: null });
  });
});

describe("deleteWord", () => {
  it("removes only the matched word and preserves version, stats and the rest", () => {
    const state: LearningState = {
      version: 1,
      words: [makeWord(1), makeWord(2)],
      stats: { day: "2026-01-01", todayReviewed: 3 },
      updatedAt: NOW,
    };

    const result = deleteWord(state, "en:word1", NOW + 100);

    expect(result.deleted).toBe(true);
    expect(result.state.version).toBe(1);
    expect(result.state.stats).toEqual(state.stats);
    expect(result.state.updatedAt).toBe(NOW + 100);
    expect(result.state.words.map((word) => word.id)).toEqual(["en:word2"]);
    // The input state is not mutated.
    expect(state.words).toHaveLength(2);
  });

  it("returns the unchanged state reference for an unknown id", () => {
    const state: LearningState = { ...emptyLearningState(), words: [makeWord(1)] };

    const result = deleteWord(state, "en:missing", NOW);

    expect(result.deleted).toBe(false);
    expect(result.state).toBe(state);
  });
});
