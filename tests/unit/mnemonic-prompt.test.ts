import { describe, expect, it } from "vitest";
import { buildMnemonicPrompt, MNEMONIC_MAX_CHARS, sanitizeCaption } from "../../src/shared/mnemonic";

const base = {
  surface: "outlive",
  termLang: "en",
  pos: "v.",
  meaning: "比……存在得更久",
  sentence: "Small tools often outlive their larger competitors.",
  lang: "zh-CN",
};

describe("mnemonic prompt", () => {
  it("hands the model the word, its meaning and the original sentence", () => {
    const messages = buildMnemonicPrompt(base);
    const user = messages.find((message) => message.role === "user")!.content as string;

    expect(user).toContain("outlive");
    expect(user).toContain("比……存在得更久");
    expect(user).toContain("Small tools often outlive their larger competitors.");
  });

  it("asks for a concrete one-line picture in the review language", () => {
    const messages = buildMnemonicPrompt(base);
    const system = messages.find((message) => message.role === "system")!.content as string;

    expect(system).toContain("画面");
    expect(system).toContain(String(MNEMONIC_MAX_CHARS));
    expect(system).toContain("中文");
  });

  it("skips the sentence line when the word has no context", () => {
    const messages = buildMnemonicPrompt({ ...base, sentence: "" });
    const user = messages.find((message) => message.role === "user")!.content as string;

    expect(user).not.toContain("原句");
    expect(user).toContain("outlive");
  });
});

describe("sanitizeCaption", () => {
  it("strips wrapping quotes and collapses the answer to one line", () => {
    expect(sanitizeCaption('"小工具活过了对手"\n')).toBe("小工具活过了对手");
    expect(sanitizeCaption("「小工具\n活过了对手」")).toBe("小工具 活过了对手");
  });

  it("drops markdown furniture the model adds anyway", () => {
    expect(sanitizeCaption("**画面**：猫把词藏进怀里")).toBe("画面：猫把词藏进怀里");
    expect(sanitizeCaption("1. 猫把词藏进怀里")).toBe("猫把词藏进怀里");
  });

  it("caps the caption at the memory-hook budget", () => {
    const long = "猫".repeat(MNEMONIC_MAX_CHARS + 20);
    expect(sanitizeCaption(long)).toHaveLength(MNEMONIC_MAX_CHARS);
  });

  it("returns an empty string for junk", () => {
    expect(sanitizeCaption("")).toBe("");
    expect(sanitizeCaption("   \n\t ")).toBe("");
    expect(sanitizeCaption('""')).toBe("");
  });
});
