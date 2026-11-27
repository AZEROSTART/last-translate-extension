import type { LearnWordMessage } from "./types";

export const AUTO_CLAIM_MAX_CHARS = 24;
export const AUTO_CLAIM_MAX_WORDS = 4;
export const AUTO_CLAIM_MEANING_MAX = 120;

const WORD_SPLIT = /[\s\u3000，。；：！？、（）【】《》“”‘’…·]+/u;

/** Tokens whose trailing dot does not end a sentence ("v.", "e.g.", ...). */
const NON_TERMINATING_ABBR = new Set([
  "v", "vt", "vi", "n", "adj", "adv", "prep", "conj", "pron", "int", "interj",
  "phr", "pl", "aux", "abbr", "art", "num", "det",
  "e", "g", "i", "etc", "vs", "cf", "dr", "mr", "mrs", "ms", "prof", "st",
  "no", "fig", "approx",
]);

const SENTENCE_CHAR = /[。！？!?]/;
const DOTTED_ABBREVIATION = /(?:^|[^A-Za-z])(?:[A-Za-z]\.){2,}$/;

const BLOCK_PREFIX = /^\s*(?:>+\s*|#{1,6}\s+)/;
const LIST_MARKER = /^\s*(?:\d+[.)、]|[-*•·])(?:\s+|$)/;
const POS_WORD =
  "(?:v|vt|vi|n|adj|adv|prep|conj|pron|int|interj|phr|pl|aux|abbr|art|num|det)";
const POS_MARKER = new RegExp(
  `^\\s*(?:` +
    `\\(\\s*${POS_WORD}\\.?\\s*\\)|` +
    `（\\s*${POS_WORD}\\.?\\s*）|` +
    `\\[\\s*${POS_WORD}\\.?\\s*\\]|` +
    `【\\s*${POS_WORD}\\.?\\s*】|` +
    `${POS_WORD}\\.` +
    `)(?:\\s+|$)`,
  "i",
);

/** Only short words/phrases are worth turning into review cards. */
export function isClaimableTerm(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > AUTO_CLAIM_MAX_CHARS) return false;
  const words = trimmed.split(WORD_SPLIT).filter(Boolean);
  return words.length > 0 && words.length <= AUTO_CLAIM_MAX_WORDS;
}

/** ISO language tag → short prefix, e.g. "zh-CN" → "zh". */
export function langPrefix(lang: string): string {
  return lang.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

/** Strip simple inline markdown wrappers without touching `snake_case`. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
}

/** Iteratively drop list numbering and leading part-of-speech labels. */
function stripLeadingMarkers(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(LIST_MARKER, "").replace(POS_MARKER, "");
    if (next === current) return current;
    current = next;
  }
}

/** Index of the first real sentence boundary, or -1 when there is none. */
function sentenceEndIndex(line: string): number {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (SENTENCE_CHAR.test(char)) return i;
    if (char !== ".") continue;

    const previous = line[i - 1] ?? "";
    const next = line[i + 1] ?? "";
    // Ellipsis or a decimal point.
    if (previous === "." || next === ".") continue;
    if (/\d/.test(previous) && /\d/.test(next)) continue;
    // "e.g.", "i.e.", "U.S." — any run of single-letter dot groups.
    if (DOTTED_ABBREVIATION.test(line.slice(0, i + 1))) continue;
    // A trailing dot after a known abbreviation token is not an ending.
    const token = /([A-Za-z]+)$/.exec(line.slice(0, i));
    if (token && NON_TERMINATING_ABBR.has(token[1].toLowerCase())) continue;
    return i;
  }
  return -1;
}

/**
 * First sentence of an answer, stripped of markdown/list/POS noise and capped
 * for storage. A bare marker line ("1. ", "v. ") yields "".
 */
export function firstSentence(answer: string): string {
  const line = answer
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "";

  const withoutBlock = line.replace(BLOCK_PREFIX, "");
  const withoutInline = stripInlineMarkdown(withoutBlock);
  const cleaned = stripLeadingMarkers(withoutInline);

  const end = sentenceEndIndex(cleaned);
  const head = (end >= 0 ? cleaned.slice(0, end) : cleaned).trim();
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
  /** When non-empty, only these languages may be claimed. */
  learningLangs?: string[];
}

/** Selection edges often carry sentence punctuation; keep inner marks (don't, well-known). */
export function cleanTerm(text: string): string {
  return text
    .trim()
    .replace(/^[\s"'“”‘’().,;:!?，。；：！？、]+/u, "")
    .replace(/[\s"'“”‘’().,;:!?，。；：！？、]+$/u, "");
}

/** Build the learn-word message for an "explain" answer, or null to skip it. */
export function autoClaimRequest(input: AutoClaimInput): LearnWordMessage | null {
  const quote = cleanTerm(input.quote ?? "");
  if (!quote || !isClaimableTerm(quote)) return null;

  const meaning = firstSentence(input.answer ?? "");
  if (!meaning) return null;

  const termLang = input.termLang?.trim() || "en";
  const termPrefix = langPrefix(termLang);
  const glossPrefix = langPrefix(input.glossLang);
  // A "term" in the answer language is just a gloss, not a word to learn.
  if (termPrefix && glossPrefix && termPrefix === glossPrefix) return null;

  if (input.learningLangs && input.learningLangs.length > 0) {
    const allowed = input.learningLangs.map(langPrefix).filter(Boolean);
    if (!allowed.includes(termPrefix)) return null;
  }

  const sentence = (input.paragraph?.trim() || quote).slice(0, 240);
  return {
    type: "learn-word",
    surface: quote,
    termLang,
    glossLang: input.glossLang,
    meaning,
    sentence,
    pageUrl: input.pageUrl,
    ...(input.pageTitle ? { pageTitle: input.pageTitle } : {}),
  };
}
