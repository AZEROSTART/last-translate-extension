import { beforeEach, describe, expect, it } from "vitest";
import { handleLearningMessage } from "../../src/background/learning";
import { getLearning } from "../../src/shared/learning-storage";

beforeEach(() => chrome.storage.local.clear());

const learn = {
  type: "learn-word" as const,
  surface: "outlive",
  termLang: "en",
  glossLang: "zh",
  meaning: "比…久",
  sentence: "s1",
  pageUrl: "https://example.test/a",
};

describe("handleLearningMessage", () => {
  it("records a word once and reports created:false on repeat", async () => {
    const first = await handleLearningMessage(learn);
    const second = await handleLearningMessage({ ...learn, surface: "Outlive", sentence: "s2" });

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });

    const state = await getLearning();
    expect(state.words).toHaveLength(1);
    expect(state.words[0].box).toBe(0);
    expect(state.words[0].contexts).toHaveLength(2);
  });

  it("returns a due label with the first card", async () => {
    const response = (await handleLearningMessage(learn)) as {
      dueAt: number;
      nextDueLabel: string;
    };
    expect(response.dueAt).toBeGreaterThan(0);
    expect(response.nextDueLabel).toBe("10 分钟后");
  });

  it("does not lose writes when reviews arrive concurrently", async () => {
    await handleLearningMessage(learn);
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        handleLearningMessage({ type: "review-answer", id: "en:outlive", grade: "good" }),
      ),
    );
    const state = await getLearning();
    expect(state.words[0].reviewsCount).toBe(5);
  });

  it("returns ok:false for an unknown review id", async () => {
    expect(await handleLearningMessage({ type: "review-answer", id: "en:none", grade: "good" })).toEqual({
      ok: false,
    });
  });

  it("serves the whole learning state", async () => {
    await handleLearningMessage(learn);
    const response = (await handleLearningMessage({ type: "get-learning" })) as {
      ok: true;
      state: { words: unknown[] };
    };
    expect(response.ok).toBe(true);
    expect(response.state.words).toHaveLength(1);
  });

  it("returns not-implemented for lookup-gloss", async () => {
    expect(
      await handleLearningMessage({
        type: "lookup-gloss",
        termLang: "en",
        glossLang: "es",
        surface: "x",
        sentence: "y",
      }),
    ).toEqual({ ok: false, reason: "not-implemented" });
  });

  it("ignores unknown message types", async () => {
    expect(await handleLearningMessage({ type: "something-else" })).toBeNull();
    expect(await handleLearningMessage(null)).toBeNull();
  });
});
