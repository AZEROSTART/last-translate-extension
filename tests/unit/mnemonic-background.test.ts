import { describe, expect, it, vi } from "vitest";
import { generateMnemonic, type MnemonicDeps } from "../../src/background/mnemonic";
import { emptyLearningState } from "../../src/shared/learning-storage";
import type { LearningState, LearningWord, Settings } from "../../src/shared/types";

function word(over: Partial<LearningWord> = {}): LearningWord {
  return {
    id: "en:outlive",
    termLang: "en",
    surface: "outlive",
    pos: "v.",
    glosses: [{ lang: "zh-CN", meaning: "比……存在得更久", source: "translation", at: 1 }],
    glossLang: "zh-CN",
    contexts: [{ sentence: "Small tools often outlive their competitors.", pageUrl: "x", at: 1 }],
    status: "learning",
    box: 0,
    dueAt: 1,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    reviews: [],
    reviewsCount: 0,
    correctCount: 0,
    checksSinceSpot: 0,
    ...over,
  };
}

function stateWith(entry: LearningWord | undefined): LearningState {
  const state = emptyLearningState();
  if (entry) state.words.push(entry);
  return state;
}

function settings(over: Partial<Settings> = {}): Settings {
  return {
    providers: [
      {
        id: "p1",
        name: "P1",
        kind: "custom",
        baseURL: "http://127.0.0.1:9",
        apiKey: "k",
        model: "m",
        createdAt: 1,
      },
    ],
    activeProviderId: "p1",
    targetLang: "zh-CN",
    ...over,
  } as Settings;
}

function deps(over: Partial<MnemonicDeps> = {}): MnemonicDeps {
  return {
    getLearning: vi.fn().mockResolvedValue(stateWith(word())),
    getSettings: vi.fn().mockResolvedValue(settings()),
    complete: vi.fn().mockResolvedValue({ text: "「小工具活过了大公司，猫把它抱进怀里」" }),
    save: vi.fn().mockResolvedValue(undefined),
    now: () => 1700000000000,
    ...over,
  };
}

describe("generateMnemonic", () => {
  it("returns the cached picture without calling the model", async () => {
    const cached = { caption: "猫把词藏进怀里", lang: "zh-CN", at: 5 };
    const d = deps({ getLearning: vi.fn().mockResolvedValue(stateWith(word({ mnemonic: cached }))) });

    const res = await generateMnemonic("en:outlive", d);

    expect(res).toEqual({ ok: true, mnemonic: cached });
    expect(d.complete).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("generates one caption, cleans it and stores it", async () => {
    const d = deps();

    const res = await generateMnemonic("en:outlive", d);

    expect(res).toEqual({
      ok: true,
      mnemonic: { caption: "小工具活过了大公司，猫把它抱进怀里", lang: "zh-CN", at: 1700000000000 },
    });
    expect(d.save).toHaveBeenCalledWith("en:outlive", {
      caption: "小工具活过了大公司，猫把它抱进怀里",
      lang: "zh-CN",
      at: 1700000000000,
    });
  });

  it("fails without storing when the provider errors", async () => {
    const d = deps({ complete: vi.fn().mockRejectedValue(new Error("offline")) });

    const res = await generateMnemonic("en:outlive", d);

    expect(res).toEqual({ ok: false, reason: "failed" });
    expect(d.save).not.toHaveBeenCalled();
  });

  it("fails when the model answers with nothing usable", async () => {
    const d = deps({ complete: vi.fn().mockResolvedValue({ text: '""' }) });

    const res = await generateMnemonic("en:outlive", d);

    expect(res).toEqual({ ok: false, reason: "failed" });
    expect(d.save).not.toHaveBeenCalled();
  });

  it("reports no-provider instead of calling the model", async () => {
    const d = deps({ getSettings: vi.fn().mockResolvedValue(settings({ providers: [], activeProviderId: "" })) });

    const res = await generateMnemonic("en:outlive", d);

    expect(res).toEqual({ ok: false, reason: "no-provider" });
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("reports unknown words instead of guessing", async () => {
    const d = deps({ getLearning: vi.fn().mockResolvedValue(stateWith(undefined)) });

    const res = await generateMnemonic("en:gone", d);

    expect(res).toEqual({ ok: false, reason: "unknown-word" });
  });

  it("asks for the caption in the review answer language", async () => {
    const d = deps({
      getLearning: vi
        .fn()
        .mockResolvedValue(stateWith(word({ glossLang: "ja" }))),
    });

    await generateMnemonic("en:outlive", d);

    const req = (d.complete as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const system = req.messages.find((m: { role: string }) => m.role === "system").content as string;
    expect(system).toContain("日语");
  });
});
