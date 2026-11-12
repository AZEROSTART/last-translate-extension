import { INTERVALS_MS, applyGrade } from "./srs";
import type {
  LearnWordMessage,
  LearningGrade,
  LearningState,
  LearningWord,
  ReviewEntry,
  WordContext,
  WordGloss,
} from "./types";

export const LEARNING_KEY = "learning";
export const MAX_WORDS = 2000;
const MAX_CONTEXTS = 3;
const MAX_REVIEWS = 10;
const MAX_SENTENCE = 240;

/** Trim, collapse whitespace, lowercase. Two surfaces match iff ids match. */
export function normalizeSurface(surface: string): string {
  return surface.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** A card identity: same spelling in two languages is two cards. */
export function wordId(termLang: string, surface: string): string {
  return `${termLang}:${normalizeSurface(surface)}`;
}

export function emptyLearningState(): LearningState {
  return {
    version: 1,
    words: [],
    stats: { day: "", todayReviewed: 0 },
    updatedAt: 0,
  };
}

function localDay(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseGlosses(value: unknown): WordGloss[] {
  if (!Array.isArray(value)) return [];
  const out: WordGloss[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const lang = asString(item.lang);
    const meaning = asString(item.meaning);
    if (!lang || !meaning) continue;
    out.push({
      lang,
      meaning,
      source: item.source === "lookup" ? "lookup" : "translation",
      at: asNumber(item.at, 0),
    });
  }
  return out;
}

function parseContexts(value: unknown): WordContext[] {
  if (!Array.isArray(value)) return [];
  const out: WordContext[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const sentence = asString(item.sentence);
    const pageUrl = asString(item.pageUrl);
    if (!sentence || !pageUrl) continue;
    const context: WordContext = { sentence, pageUrl, at: asNumber(item.at, 0) };
    if (typeof item.pageTitle === "string") context.pageTitle = item.pageTitle;
    out.push(context);
  }
  return out.slice(-MAX_CONTEXTS);
}

function parseReviews(value: unknown): ReviewEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const grade = item.grade;
    if (grade !== "again" && grade !== "hard" && grade !== "good") continue;
    const entry: ReviewEntry = {
      at: asNumber(item.at, 0),
      grade,
      box: asNumber(item.box, 0),
    };
    if (typeof item.spot === "boolean") entry.spot = item.spot;
    if (typeof item.spotCorrect === "boolean") entry.spotCorrect = item.spotCorrect;
    if (typeof item.termLang === "string") entry.termLang = item.termLang;
    if (typeof item.glossLang === "string") entry.glossLang = item.glossLang;
    out.push(entry);
  }
  return out.slice(-MAX_REVIEWS);
}

function parseWord(value: unknown): LearningWord | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const termLang = asString(value.termLang);
  const surface = asString(value.surface);
  const glossLang = asString(value.glossLang);
  if (!id || !termLang || !surface) return null;

  const status = value.status === "mastered" ? "mastered" : "learning";
  const word: LearningWord = {
    id,
    termLang,
    surface,
    glosses: parseGlosses(value.glosses),
    glossLang: glossLang || "zh-CN",
    contexts: parseContexts(value.contexts),
    status,
    box: asNumber(value.box, 0),
    dueAt:
      value.dueAt === null || status === "mastered"
        ? null
        : typeof value.dueAt === "number" && Number.isFinite(value.dueAt)
          ? value.dueAt
          : 0,
    createdAt: asNumber(value.createdAt, 0),
    updatedAt: asNumber(value.updatedAt, 0),
    lastSeenAt: asNumber(value.lastSeenAt, 0),
    reviews: parseReviews(value.reviews),
    reviewsCount: asNumber(value.reviewsCount, 0),
    correctCount: asNumber(value.correctCount, 0),
    checksSinceSpot: asNumber(value.checksSinceSpot, 0),
  };
  if (typeof value.pos === "string") word.pos = value.pos;
  if (typeof value.mascotId === "string") word.mascotId = value.mascotId;
  return word;
}

/** Never throws: any malformed part falls back to a safe default. */
export function parseLearningState(raw: unknown): LearningState {
  if (!isRecord(raw)) return emptyLearningState();
  const words = Array.isArray(raw.words)
    ? raw.words.map(parseWord).filter((word): word is LearningWord => word !== null)
    : [];
  const stats = isRecord(raw.stats)
    ? {
        day: asString(raw.stats.day),
        todayReviewed: asNumber(raw.stats.todayReviewed, 0),
      }
    : { day: "", todayReviewed: 0 };
  return {
    version: 1,
    words,
    stats,
    updatedAt: asNumber(raw.updatedAt, 0),
  };
}

function mergeGlosses(
  existing: WordGloss[],
  glossLang: string,
  meaning: string,
  extra: Record<string, string> | undefined,
  now: number,
): WordGloss[] {
  const byLang = new Map<string, WordGloss>();
  for (const gloss of existing) byLang.set(gloss.lang, gloss);
  if (meaning) {
    byLang.set(glossLang, { lang: glossLang, meaning, source: "translation", at: now });
  }
  for (const [lang, value] of Object.entries(extra ?? {})) {
    if (typeof value !== "string" || !value.trim()) continue;
    byLang.set(lang, { lang, meaning: value, source: "translation", at: now });
  }
  return [...byLang.values()];
}

function mergeContexts(existing: WordContext[], incoming: WordContext): WordContext[] {
  const deduped = existing.filter((context) => context.sentence !== incoming.sentence);
  deduped.push(incoming);
  return deduped.slice(-MAX_CONTEXTS);
}

function pruneWords(words: LearningWord[]): LearningWord[] {
  if (words.length <= MAX_WORDS) return words;
  const next = [...words];
  while (next.length > MAX_WORDS) {
    const mastered = next.filter((word) => word.status === "mastered");
    const pool = mastered.length > 0 ? mastered : next;
    let oldest = 0;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].updatedAt < pool[oldest].updatedAt) oldest = i;
    }
    next.splice(next.indexOf(pool[oldest]), 1);
  }
  return next;
}

export interface MergeResult {
  state: LearningState;
  created: boolean;
  word: LearningWord;
}

/** Idempotent capture: merging never resets scheduling or the claimed mascot. */
export function mergeLearnedWord(
  state: LearningState,
  input: LearnWordMessage,
  now: number,
): MergeResult {
  const id = wordId(input.termLang, input.surface);
  const sentence = input.sentence.slice(0, MAX_SENTENCE);
  const context: WordContext = {
    sentence,
    pageUrl: input.pageUrl,
    at: now,
  };
  if (input.pageTitle) context.pageTitle = input.pageTitle;

  const existing = state.words.find((word) => word.id === id);
  if (existing) {
    const word: LearningWord = {
      ...existing,
      surface: input.surface,
      glosses: mergeGlosses(existing.glosses, input.glossLang, input.meaning, input.glosses, now),
      contexts: mergeContexts(existing.contexts, context),
      updatedAt: now,
      lastSeenAt: now,
    };
    if (input.pos) word.pos = input.pos;
    const words = state.words.map((item) => (item.id === id ? word : item));
    return {
      state: { ...state, words: pruneWords(words), updatedAt: now },
      created: false,
      word,
    };
  }

  const word: LearningWord = {
    id,
    termLang: input.termLang,
    surface: input.surface,
    glosses: mergeGlosses([], input.glossLang, input.meaning, input.glosses, now),
    glossLang: input.glossLang,
    contexts: [context],
    status: "learning",
    box: 0,
    dueAt: now + INTERVALS_MS[0],
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    reviews: [],
    reviewsCount: 0,
    correctCount: 0,
    checksSinceSpot: 0,
  };
  if (input.pos) word.pos = input.pos;
  if (input.mascotId) word.mascotId = input.mascotId;

  const words = pruneWords([...state.words, word]);
  return {
    state: { ...state, words, updatedAt: now },
    created: true,
    word,
  };
}

export interface AnswerInput {
  id: string;
  grade: LearningGrade;
  glossLang?: string;
  spot?: boolean;
  spotCorrect?: boolean;
}

export interface AnswerResult {
  state: LearningState;
  word: LearningWord | null;
}

/** Record one self-assessment and advance the shared box. */
export function applyReviewAnswer(
  state: LearningState,
  input: AnswerInput,
  now: number,
): AnswerResult {
  const existing = state.words.find((word) => word.id === input.id);
  if (!existing) return { state, word: null };

  const graded = applyGrade(existing, input.grade, now);
  const entry: ReviewEntry = {
    at: now,
    grade: input.grade,
    box: graded.box,
    termLang: existing.termLang,
    glossLang: input.glossLang ?? existing.glossLang,
  };
  if (input.spot !== undefined) entry.spot = input.spot;
  if (input.spotCorrect !== undefined) entry.spotCorrect = input.spotCorrect;

  const word: LearningWord = {
    ...existing,
    status: graded.status,
    box: graded.box,
    dueAt: graded.dueAt,
    reviews: [...existing.reviews, entry].slice(-MAX_REVIEWS),
    reviewsCount: existing.reviewsCount + 1,
    correctCount: existing.correctCount + (graded.correct ? 1 : 0),
    checksSinceSpot: input.spot ? 0 : existing.checksSinceSpot + 1,
    updatedAt: now,
  };

  const day = localDay(now);
  const stats =
    state.stats.day === day
      ? { day, todayReviewed: state.stats.todayReviewed + 1 }
      : { day, todayReviewed: 1 };

  return {
    state: {
      ...state,
      words: state.words.map((item) => (item.id === word.id ? word : item)),
      stats,
      updatedAt: now,
    },
    word,
  };
}

export async function getLearning(): Promise<LearningState> {
  const stored = (await chrome.storage.local.get(LEARNING_KEY))[LEARNING_KEY];
  return parseLearningState(stored);
}

export async function saveLearning(state: LearningState): Promise<void> {
  await chrome.storage.local.set({ [LEARNING_KEY]: state });
}
