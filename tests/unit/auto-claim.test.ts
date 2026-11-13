import { describe, expect, it } from "vitest";
import {
  AUTO_CLAIM_MEANING_MAX,
  autoClaimRequest,
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
});

describe("firstSentence", () => {
  it("cuts at the first sentence end", () => {
    expect(firstSentence("比……存在得更久。例：Small tools outlive them.")).toBe("比……存在得更久");
    expect(firstSentence("first line\nsecond line")).toBe("first line");
  });

  it("caps the meaning length", () => {
    expect(firstSentence("a".repeat(200))).toHaveLength(AUTO_CLAIM_MEANING_MAX);
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
});
