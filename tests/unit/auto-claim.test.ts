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
