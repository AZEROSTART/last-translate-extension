import { describe, expect, it } from "vitest";
import {
  AUTO_CLAIM_MAX_CHARS,
  AUTO_CLAIM_MAX_WORDS,
  AUTO_CLAIM_MEANING_MAX,
  autoClaimRequest,
  cleanTerm,
  firstSentence,
  isClaimableTerm,
} from "../../src/shared/auto-claim";

describe("isClaimableTerm", () => {
  it("accepts a word or a short phrase", () => {
    expect(isClaimableTerm("outlive")).toBe(true);
    expect(isClaimableTerm("  take off  ")).toBe(true);
    expect(isClaimableTerm("yellow-bellied")).toBe(true);
    expect(isClaimableTerm("比……存在得更久")).toBe(true);
  });

  it("rejects long phrases and full sentences", () => {
    expect(isClaimableTerm("Small tools often outlive their larger competitors.")).toBe(false);
    expect(isClaimableTerm("a b c d e")).toBe(false);
    expect(isClaimableTerm("")).toBe(false);
    expect(isClaimableTerm("x".repeat(25))).toBe(false);
  });

  it("enforces the character and word boundaries", () => {
    expect(isClaimableTerm("x".repeat(AUTO_CLAIM_MAX_CHARS))).toBe(true);
    expect(isClaimableTerm("x".repeat(AUTO_CLAIM_MAX_CHARS + 1))).toBe(false);
    const words = Array.from({ length: AUTO_CLAIM_MAX_WORDS }, () => "a").join(" ");
    expect(isClaimableTerm(words)).toBe(true);
    expect(isClaimableTerm(`${words} a`)).toBe(false);
  });
});

describe("firstSentence", () => {
  it("cuts at the first sentence end", () => {
    expect(firstSentence("比……存在得更久。例：Small tools outlive them.")).toBe("比……存在得更久");
    expect(firstSentence("first line\nsecond line")).toBe("first line");
  });

  it("treats ！ ？ and ! as sentence ends too", () => {
    expect(firstSentence("太好了！例：")).toBe("太好了");
    expect(firstSentence("真的吗？例：")).toBe("真的吗");
    expect(firstSentence("Great!Example:")).toBe("Great");
  });

  it("caps the meaning length", () => {
    expect(firstSentence("a".repeat(200))).toHaveLength(AUTO_CLAIM_MEANING_MAX);
  });
});

describe("cleanTerm", () => {
  it("strips edge punctuation but keeps inner marks", () => {
    expect(cleanTerm("outlive.")).toBe("outlive");
    expect(cleanTerm("  (take off)  ")).toBe("take off");
    expect(cleanTerm("don't")).toBe("don't");
    expect(cleanTerm("...")).toBe("");
  });
});

describe("autoClaimRequest", () => {
  const base = {
    quote: "outlive",
    termLang: "en",
    answer: "比……存在得更久。",
    paragraph: "Small tools often outlive their larger competitors.",
    pageUrl: "https://example.com/a",
    pageTitle: "A",
    glossLang: "zh-CN",
  };

  it("builds a learn-word message for a short term", () => {
    expect(autoClaimRequest(base)).toMatchObject({
      type: "learn-word",
      surface: "outlive",
      termLang: "en",
      glossLang: "zh-CN",
      meaning: "比……存在得更久",
    });
  });

  it("skips long quotes, empty answers and blank termLang falls back to en", () => {
    expect(autoClaimRequest({ ...base, quote: "a whole sentence with many words" })).toBeNull();
    expect(autoClaimRequest({ ...base, answer: "   " })).toBeNull();
    expect(autoClaimRequest({ ...base, termLang: "" })?.termLang).toBe("en");
  });

  it("falls back to the quote when there is no paragraph", () => {
    expect(autoClaimRequest({ ...base, paragraph: undefined })?.sentence).toBe("outlive");
  });

  it("stores the cleaned term and uses it as the sentence fallback", () => {
    const message = autoClaimRequest({ ...base, quote: "outlive.", paragraph: undefined });
    expect(message?.surface).toBe("outlive");
    expect(message?.sentence).toBe("outlive");
  });
});

describe("firstSentence markdown, markers and abbreviations", () => {
  it("strips bold and inline-code wrappers", () => {
    expect(firstSentence("**outlive**：比……存在得更久。例：")).toBe("outlive：比……存在得更久");
    expect(firstSentence("`outlive`：比……存在得更久。")).toBe("outlive：比……存在得更久");
  });

  it("strips numbered list markers", () => {
    expect(firstSentence("1. 意思是比……存在得更久。例：")).toBe("意思是比……存在得更久");
  });

  it("strips leading POS labels, bare and parenthesized", () => {
    expect(firstSentence("v. 比……存在得更久。")).toBe("比……存在得更久");
    expect(firstSentence("(adj.) 持久的。")).toBe("持久的");
  });

  it("does not split on inline abbreviations", () => {
    expect(firstSentence("e.g. 比如小工具。")).toBe("e.g. 比如小工具");
    expect(firstSentence("表示举例（e.g. 苹果）。下一句。")).toBe("表示举例（e.g. 苹果）");
  });

  it("does not split decimals", () => {
    expect(firstSentence("Version 3.5 works. Next.")).toBe("Version 3.5 works");
  });

  it("preserves snake_case while stripping italic underscores", () => {
    expect(firstSentence("Use snake_case_here in this line. Next.")).toBe(
      "Use snake_case_here in this line",
    );
    expect(firstSentence("_softly_ does it. Next.")).toBe("softly does it");
  });

  it("returns empty for marker-only input", () => {
    expect(firstSentence("1. ")).toBe("");
    expect(firstSentence("v. ")).toBe("");
  });
});

describe("autoClaimRequest language gating", () => {
  const base = {
    quote: "outlive",
    termLang: "en",
    answer: "比……存在得更久。",
    paragraph: "Small tools often outlive their larger competitors.",
    pageUrl: "https://example.com/a",
    glossLang: "zh-CN",
  };

  it("rejects a term whose language is the answer language", () => {
    expect(autoClaimRequest({ ...base, termLang: "zh", glossLang: "zh-CN" })).toBeNull();
    expect(autoClaimRequest({ ...base, termLang: "en-US", glossLang: "en" })).toBeNull();
  });

  it("rejects a language outside the configured learning languages", () => {
    expect(
      autoClaimRequest({ ...base, quote: "生きる", termLang: "ja", learningLangs: ["en"] }),
    ).toBeNull();
  });

  it("accepts a matching language prefix", () => {
    const message = autoClaimRequest({
      ...base,
      quote: "sobrevivir",
      termLang: "es-MX",
      learningLangs: ["en", "es"],
    });
    expect(message?.termLang).toBe("es-MX");
    expect(message?.surface).toBe("sobrevivir");
  });
});
