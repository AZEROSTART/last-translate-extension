import { describe, it, expect } from "vitest";
import { estimateTokens } from "../../src/shared/token-estimate";
import { groupSegments, buildTranslateMessages, parseNumberedResponse, PromptParseError } from "../../src/shared/prompt";

describe("estimateTokens", () => {
  it("counts CJK denser than latin", () => {
    expect(estimateTokens("你好世界你好世界")).toBeGreaterThan(estimateTokens("hello"));
    expect(estimateTokens("")).toBe(0);
  });

  it("applies the documented divisors and rounds up", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
  });
});

describe("groupSegments", () => {
  it("respects maxItems", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `p_${i}`, text: "hello world" }));
    const groups = groupSegments(items, { maxInputTokens: 10_000, maxItems: 20 });
    expect(groups.map(g => g.length)).toEqual([20, 5]);
  });

  it("respects the token budget", () => {
    // 1200 latin chars ≈ 300 tokens, so 10 items (3000 tokens) must span >1 group at 1500.
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `p_${i}`, text: "x".repeat(1200) }));
    const groups = groupSegments(items, { maxInputTokens: 1500, maxItems: 20 });
    expect(groups.every(g => g.reduce((n, it) => n + estimateTokens(it.text), 0) <= 1500 || g.length === 1)).toBe(true);
    expect(groups.length).toBeGreaterThan(1);
  });

  it("never drops an item", () => {
    const items = Array.from({ length: 37 }, (_, i) => ({ id: `p_${i}`, text: "字".repeat(50) }));
    expect(groupSegments(items, { maxInputTokens: 300, maxItems: 5 }).flat()).toHaveLength(37);
  });

  it("returns no groups for no items", () => {
    expect(groupSegments([], { maxInputTokens: 100, maxItems: 5 })).toEqual([]);
  });

  it("keeps an over-budget item in a group of its own", () => {
    const items = [
      { id: "p_0", text: "small" },
      { id: "p_1", text: "x".repeat(10_000) },
      { id: "p_2", text: "small" },
    ];
    const groups = groupSegments(items, { maxInputTokens: 100, maxItems: 20 });
    expect(groups.map(g => g.map(it => it.id))).toEqual([["p_0"], ["p_1"], ["p_2"]]);
  });
});

describe("buildTranslateMessages", () => {
  it("numbers segments and keeps page text out of the system prompt", () => {
    const [sys, user] = buildTranslateMessages([{ id: "p_1", text: "Hello" }], "zh-CN", "SYS");
    expect(sys.role).toBe("system");
    expect(sys.content).toBe("SYS");
    expect(user.role).toBe("user");
    expect(user.content).toContain("[1] Hello");
  });

  it("substitutes the target language placeholder", () => {
    const [sys, user] = buildTranslateMessages(
      [{ id: "p_1", text: "Hello" }],
      "ja",
      "Translate into {{targetLang}}. Only {{targetLang}} output.",
    );
    expect(sys.content).toBe("Translate into ja. Only ja output.");
    expect(user.content).toBe("[1] Hello");
  });

  it("numbers a batch from 1 and never leaks segment text into the system prompt", () => {
    const items = [
      { id: "p_1", text: "Alpha" },
      { id: "p_2", text: "Beta" },
    ];
    const [sys, user] = buildTranslateMessages(items, "zh-CN", "SYS");
    expect(sys.content).not.toContain("Alpha");
    expect(sys.content).not.toContain("Beta");
    expect(user.content).toBe("[1] Alpha\n[2] Beta");
  });
});

describe("parseNumberedResponse", () => {
  it("maps numbered lines back to ids", () => {
    const m = parseNumberedResponse("[1] 甲\n[2] 乙", ["p_1", "p_2"]);
    expect(m.get("p_1")).toBe("甲");
    expect(m.get("p_2")).toBe("乙");
  });

  it("strips markdown fences", () => {
    const m = parseNumberedResponse("```\n[1] 甲\n```", ["p_1"]);
    expect(m.get("p_1")).toBe("甲");
  });

  it("throws when the model returns fewer segments than requested", () => {
    expect(() => parseNumberedResponse("[1] 甲", ["p_1", "p_2"])).toThrow(PromptParseError);
  });

  it("throws instead of misassigning when an index is out of range", () => {
    expect(() => parseNumberedResponse("[1] 甲\n[3] 丙", ["p_1", "p_2"])).toThrow(PromptParseError);
  });

  it("throws on duplicate indices", () => {
    expect(() => parseNumberedResponse("[1] 甲\n[1] 乙", ["p_1"])).toThrow(PromptParseError);
  });

  it("throws on index zero", () => {
    expect(() => parseNumberedResponse("[0] 甲", ["p_1"])).toThrow(PromptParseError);
  });

  it("keeps multi-line segment text inside its own segment", () => {
    const m = parseNumberedResponse("[1] 第一行\n第二行\n[2] 乙", ["p_1", "p_2"]);
    expect(m.get("p_1")).toBe("第一行\n第二行");
    expect(m.get("p_2")).toBe("乙");
  });
});
