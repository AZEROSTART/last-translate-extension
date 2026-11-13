import type { LearnWordMessage } from "./types";

export const AUTO_CLAIM_MAX_CHARS = 24;
export const AUTO_CLAIM_MAX_WORDS = 4;
export const AUTO_CLAIM_MEANING_MAX = 120;

const WORD_SPLIT = /[\s\u3000，。；：！？、（）【】《》“”‘’…·]+/u;
const SENTENCE_END = /[。！？.!?\n]/;

/** Only short words/phrases are worth turning into review cards. */
export function isClaimableTerm(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > AUTO_CLAIM_MAX_CHARS) return false;
  const words = trimmed.split(WORD_SPLIT).filter(Boolean);
  return words.length > 0 && words.length <= AUTO_CLAIM_MAX_WORDS;
}

/** First sentence of an answer, capped for storage. */
export function firstSentence(answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed) return "";
  const match = SENTENCE_END.exec(trimmed);
  const head = (match ? trimmed.slice(0, match.index) : trimmed).trim();
  return head.slice(0, AUTO_CLAIM_MEANING_MAX);
}

export interface AutoClaimInput {
  quote?: string;
  termLang?: string;
  answer?: string;
  paragraph?: string;
  pageUrl: string;
  pageTitle?: string;
  glossLang: string;
}

/** Build the learn-word message for an "explain" answer, or null to skip it. */
export function autoClaimRequest(input: AutoClaimInput): LearnWordMessage | null {
  const quote = input.quote?.trim() ?? "";
  if (!quote || !isClaimableTerm(quote)) return null;

  const meaning = firstSentence(input.answer ?? "");
  if (!meaning) return null;

  const sentence = (input.paragraph?.trim() || quote).slice(0, 240);
  return {
    type: "learn-word",
    surface: quote,
    termLang: input.termLang?.trim() || "en",
    glossLang: input.glossLang,
    meaning,
    sentence,
    pageUrl: input.pageUrl,
    ...(input.pageTitle ? { pageTitle: input.pageTitle } : {}),
  };
}
