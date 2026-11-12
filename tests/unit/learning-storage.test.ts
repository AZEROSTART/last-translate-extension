import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_WORDS,
  applyReviewAnswer,
  emptyLearningState,
  getLearning,
  mergeLearnedWord,
  parseLearningState,
  saveLearning,
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
