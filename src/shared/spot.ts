/** Spot checks: every third review becomes a four-way meaning question. */

import type { LearningWord } from "./types";

export interface SpotQuestion {
  options: string[];
  /** Index of the correct option. */
  answer: number;
}

/** `checksSinceSpot` already counts plain reviews; the next one is the third. */
export function shouldSpotCheck(word: LearningWord): boolean {
  return word.checksSinceSpot + 1 >= 3;
}

function meaningOf(word: LearningWord, glossLang: string): string | undefined {
  const gloss = word.glosses.find((item) => item.lang === glossLang);
  const meaning = gloss?.meaning?.trim();
  return meaning ? meaning : undefined;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build a four-way question from the local library. Returns null when the
 * library cannot supply three distinct meanings in the same language; the
 * caller then falls back to self-assessment (zero API cost either way).
 */
export function buildSpotQuestion(
  word: LearningWord,
  pool: LearningWord[],
  glossLang: string,
  seed?: number,
): SpotQuestion | null {
  const answer = meaningOf(word, glossLang);
  if (!answer) return null;

  const distractors: string[] = [];
  const seen = new Set([answer]);
  for (const candidate of pool) {
    const meaning = meaningOf(candidate, glossLang);
    if (!meaning || seen.has(meaning)) continue;
    seen.add(meaning);
    distractors.push(meaning);
    if (distractors.length === 3) break;
  }
  if (distractors.length < 3) return null;

  const random = seed === undefined ? Math.random : mulberry32(seed);
  const options = shuffle([answer, ...distractors], random);
  return { options, answer: options.indexOf(answer) };
}
