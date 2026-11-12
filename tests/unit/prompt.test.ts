import { describe, it, expect } from "vitest";
import { estimateTokens } from "../../src/shared/token-estimate";
import {
  GLOSSARY_INSTRUCTIONS,
  GLOSSARY_MARKER,
  buildFormatPrompt,
  buildPromptVersion,
  buildTranslateMessages,
  groupSegments,
  parseAnnotatedResponse,
  parseGlossaryNotes,
  parseNumberedResponse,
  PromptParseError,
} from "../../src/shared/prompt";

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

describe("buildFormatPrompt glossary contract", () => {
  it("embeds the glossary protocol once when enabled", () => {
    const on = buildFormatPrompt({ targetLang: "zh-CN", glossaryEnabled: true, glossLangs: [] });
    expect(on).toContain(GLOSSARY_INSTRUCTIONS);
    expect(on).toContain(GLOSSARY_MARKER);
    expect(on).toContain("0～3");
    expect(on).toContain("注释块是必须输出的第二部分");
  });
});

describe("parseGlossaryNotes", () => {
  const items = [
    { id: "p_1", text: "Small tools often outlive their makers. Outlive is a verb." },
    { id: "p_2", text: "Alpha beta." },
  ];

  it("maps valid notes to their segment ids", () => {
    const raw = JSON.stringify({
      "1": [
        { surface: "Outlive", pos: "v.", meaning: "比……存在得更久", example: "Small tools outlive." },
      ],
      "2": [{ surface: "Alpha", meaning: "阿尔法" }],
    });
    const notes = parseGlossaryNotes(raw, items);
    expect(notes.get("p_1")).toEqual([
      { surface: "Outlive", pos: "v.", meaning: "比……存在得更久", example: "Small tools outlive." },
    ]);
    expect(notes.get("p_2")).toEqual([{ surface: "Alpha", meaning: "阿尔法" }]);
  });

  it("drops unknown surfaces, duplicate surfaces, and malformed entries", () => {
    const raw = JSON.stringify({
      "1": [
        { surface: "missing", meaning: "不在原文" },
        { surface: "outlive", meaning: "第一次" },
        { surface: "Outlive", meaning: "重复" },
        { surface: "the", meaning: "嵌在词里" },
        { surface: "tools", meaning: 42 },
        { surface: "makers", meaning: "制造者", pos: 7, example: 8 },
      ],
    });
    expect(parseGlossaryNotes(raw, items).get("p_1")).toEqual([
      { surface: "outlive", meaning: "第一次" },
      { surface: "makers", meaning: "制造者" },
    ]);
  });

  it("keeps at most three valid notes per segment", () => {
    const raw = JSON.stringify({
      "1": [
        { surface: "Small", meaning: "小的" },
        { surface: "tools", meaning: "工具" },
        { surface: "makers", meaning: "制造者" },
        { surface: "outlive", meaning: "比……存在得更久" },
      ],
    });
    expect(parseGlossaryNotes(raw, items).get("p_1")?.map((n) => n.surface)).toEqual([
      "Small",
      "tools",
      "makers",
    ]);
  });

  it("accepts only whole-word ASCII surfaces", () => {
    const raw = JSON.stringify({
      "1": [
        { surface: "art", meaning: "艺术" },
        { surface: "he", meaning: "他" },
      ],
    });
    const notes = parseGlossaryNotes(raw, [{ id: "p_1", text: "Article and art." }]);
    expect(notes.get("p_1")?.map((n) => n.surface)).toEqual(["art"]);
  });

  it("returns an empty map for malformed JSON or a non-object", () => {
    expect(parseGlossaryNotes("{broken", items).size).toBe(0);
    expect(parseGlossaryNotes("[]", items).size).toBe(0);
    expect(parseGlossaryNotes(JSON.stringify({ "9": [{ surface: "Alpha", meaning: "x" }] }), items).size).toBe(0);
  });
});

describe("parseAnnotatedResponse", () => {
  const items = [
    { id: "p_1", text: "Small tools outlive their makers." },
    { id: "p_2", text: "Alpha beta." },
  ];

  it("parses translations and glossary after the marker", () => {
    const raw = [
      "[1] 小工具比制造者存在得更久。",
      "[2] 阿尔法贝塔。",
      GLOSSARY_MARKER,
      JSON.stringify({ "1": [{ surface: "outlive", meaning: "比……存在得更久" }] }),
    ].join("\n");
    const parsed = parseAnnotatedResponse(raw, items);
    expect(parsed.translations.get("p_1")).toBe("小工具比制造者存在得更久。");
    expect(parsed.translations.get("p_2")).toBe("阿尔法贝塔。");
    expect(parsed.glossary.get("p_1")).toEqual([
      { surface: "outlive", meaning: "比……存在得更久" },
    ]);
    expect(parsed.glossary.has("p_2")).toBe(false);
  });

  it("keeps translations when the glossary JSON is broken", () => {
    const raw = "[1] 甲\n[2] 乙\n" + GLOSSARY_MARKER + "\n{broken";
    const parsed = parseAnnotatedResponse(raw, items);
    expect(parsed.translations.get("p_1")).toBe("甲");
    expect(parsed.translations.get("p_2")).toBe("乙");
    expect(parsed.glossary.size).toBe(0);
  });

  it("still parses translations when the marker is missing", () => {
    const parsed = parseAnnotatedResponse("[1] 甲\n[2] 乙", items);
    expect(parsed.translations.get("p_1")).toBe("甲");
    expect(parsed.glossary.size).toBe(0);
  });

  it("recovers a trailing glossary JSON object even without the marker", () => {
    const raw =
      "[1] 甲\n[2] 乙\n" +
      JSON.stringify({ "2": [{ surface: "Alpha", meaning: "阿尔法" }] });
    const parsed = parseAnnotatedResponse(raw, items);
    expect(parsed.translations.get("p_1")).toBe("甲");
    expect(parsed.translations.get("p_2")).toBe("乙");
    expect(parsed.glossary.get("p_2")).toEqual([{ surface: "Alpha", meaning: "阿尔法" }]);
  });

  it("keeps glossary notes when annotations split the numbered lines", () => {
    const raw = [
      "[1] 甲",
      GLOSSARY_MARKER,
      JSON.stringify({ "1": [{ surface: "outlive", meaning: "比……存在得更久" }] }),
      "[2] 乙",
    ].join("\n");
    const parsed = parseAnnotatedResponse(raw, items);
    expect(parsed.translations.get("p_1")).toBe("甲");
    expect(parsed.translations.get("p_2")).toBe("乙");
    expect(parsed.glossary.get("p_1")).toEqual([{ surface: "outlive", meaning: "比……存在得更久" }]);
  });

  it("throws PromptParseError when the translation part is unusable", () => {
    expect(() => parseAnnotatedResponse("[1] 甲\n" + GLOSSARY_MARKER, items)).toThrow(
      PromptParseError,
    );
  });
});

describe("buildFormatPrompt", () => {
  it("always carries the format contract", () => {
    const p = buildFormatPrompt({ targetLang: "zh-CN", glossaryEnabled: false, glossLangs: [] });
    expect(p).toContain("[编号]");
    expect(p).toContain("{{targetLang}}");
    expect(p).not.toContain(GLOSSARY_MARKER);
  });

  it("lists extra gloss languages in the format layer", () => {
    const p = buildFormatPrompt({ targetLang: "zh-CN", glossaryEnabled: true, glossLangs: ["es", "ja"] });
    expect(p).toContain(GLOSSARY_MARKER);
    expect(p).toContain("es");
    expect(p).toContain("ja");
  });
});

describe("parseAnnotatedResponse glosses", () => {
  it("keeps only whitelisted gloss languages", () => {
    const items = [{ id: "p_1", text: "Small tools often outlive their rivals." }];
    const raw = `[1] 小工具往往比对手活得久\n${GLOSSARY_MARKER}\n{"1":[{"surface":"outlive","meaning":"比…活得久","glosses":{"es":"sobrevivir","xx":"bad"}}]}`;
    expect(parseAnnotatedResponse(raw, items, ["es"]).glossary.get("p_1")?.[0].glosses).toEqual({
      es: "sobrevivir",
    });
  });

  it("drops a malformed glosses object without losing the note", () => {
    const items = [{ id: "p_1", text: "Small tools often outlive their rivals." }];
    const raw = `[1] 小工具往往比对手活得久\n${GLOSSARY_MARKER}\n{"1":[{"surface":"outlive","meaning":"比…活得久","glosses":"nope"}]}`;
    const note = parseAnnotatedResponse(raw, items, ["es"]).glossary.get("p_1")?.[0];
    expect(note?.meaning).toBe("比…活得久");
    expect(note?.glosses).toBeUndefined();
  });

  it("drops overlong or empty gloss values one by one", () => {
    const items = [{ id: "p_1", text: "Small tools often outlive their rivals." }];
    const raw = `[1] 小工具往往比对手活得久\n${GLOSSARY_MARKER}\n{"1":[{"surface":"outlive","meaning":"比…活得久","glosses":{"es":"sobrevivir","ja":"   ","fr":"这是一个明显超过十二个字符限制的释义文本"}}]}`;
    expect(parseAnnotatedResponse(raw, items, ["es", "ja", "fr"]).glossary.get("p_1")?.[0].glosses).toEqual({
      es: "sobrevivir",
    });
  });
});

describe("buildPromptVersion", () => {
  it("is stable, format-versioned, and ignores the gloss languages", async () => {
    const a = await buildPromptVersion({ glossaryEnabled: true, preferenceText: "tech" });
    const b = await buildPromptVersion({ glossaryEnabled: true, preferenceText: "tech" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const c = await buildPromptVersion({ glossaryEnabled: true, preferenceText: "legal" });
    expect(c).not.toBe(a);
    const d = await buildPromptVersion({ glossaryEnabled: false, preferenceText: "tech" });
    expect(d).not.toBe(a);
  });
});
