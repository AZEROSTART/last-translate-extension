import { beforeEach, describe, expect, it } from "vitest";
import { handleLearningMessage, isLearningMessageType } from "../../src/background/learning";
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

  it("answers mnemonic requests for stored words only", async () => {
    await handleLearningMessage(learn);

    expect(await handleLearningMessage({ type: "mnemonic", id: "en:gone" })).toEqual({
      ok: false,
      reason: "unknown-word",
    });
    // No provider is configured in this test, so nothing is generated and the
    // stored word stays untouched.
    expect(await handleLearningMessage({ type: "mnemonic", id: "en:outlive" })).toEqual({
      ok: false,
      reason: "no-provider",
    });
    const state = await getLearning();
    expect(state.words[0].mnemonic).toBeUndefined();
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

  it("undoes the last review through the background and persists the rollback", async () => {
    await handleLearningMessage(learn);
    const stored = (await getLearning()).words[0];
    const dueAtBefore = stored.dueAt;

    const answered = (await handleLearningMessage({
      type: "review-answer",
      id: "en:outlive",
      grade: "good",
    })) as { ok: true; word: { box: number } };
    expect(answered.word.box).toBe(1);

    expect(isLearningMessageType("review-undo")).toBe(true);
    const undone = (await handleLearningMessage({ type: "review-undo", id: "en:outlive" })) as {
      ok: true;
      word: { box: number; dueAt: number | null };
    };
    expect(undone.ok).toBe(true);
    expect(undone.word.box).toBe(0);
    expect(undone.word.dueAt).toBe(dueAtBefore);

    const state = await getLearning();
    expect(state.words[0].box).toBe(0);
    expect(state.words[0].reviews).toHaveLength(0);
    expect(state.stats.todayReviewed).toBe(0);
  });

  it("reports the undo failure reason for an unknown word", async () => {
    const response = await handleLearningMessage({ type: "review-undo", id: "en:none" });
    expect(response).toEqual({ ok: false, reason: "unknown-word" });
  });

  it("does not treat unrelated messages as learning messages", () => {
    expect(isLearningMessageType("review-undo")).toBe(true);
    expect(isLearningMessageType("review-answer")).toBe(true);
    expect(isLearningMessageType("something-else")).toBe(false);
    expect(isLearningMessageType(null)).toBe(false);
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

describe("inline claim undo", () => {
  it("returns the card id from learn-word", async () => {
    const response = (await handleLearningMessage(learn)) as { id?: string };
    expect(response.id).toBe("en:outlive");
  });

  it("treats delete-word as a learning message", () => {
    expect(isLearningMessageType("delete-word")).toBe(true);
  });

  it("deletes a stored word through delete-word", async () => {
    await handleLearningMessage(learn);

    expect(await handleLearningMessage({ type: "delete-word", id: "en:outlive" })).toEqual({
      ok: true,
    });
    expect((await getLearning()).words).toHaveLength(0);
  });

  it("returns ok:false for an unknown or empty delete id", async () => {
    await handleLearningMessage(learn);

    expect(await handleLearningMessage({ type: "delete-word", id: "en:missing" })).toEqual({
      ok: false,
    });
    expect(await handleLearningMessage({ type: "delete-word", id: "" })).toEqual({ ok: false });
    expect((await getLearning()).words).toHaveLength(1);
  });
});
