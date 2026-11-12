import type { LearningGrade, WordStatus } from "./types";

/** Review spacing per box (spec §9). Index 0 = first review. */
export const INTERVALS_MS = [
  10 * 60 * 1000,
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  16 * 24 * 60 * 60 * 1000,
  35 * 24 * 60 * 60 * 1000,
] as const;

export const MAX_BOX = 5;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface GradeResult {
  box: number;
  dueAt: number | null;
  status: WordStatus;
  correct: boolean;
}

/**
 * Apply one self-assessment. Only the side panel drives scheduling; seeing a
 * word again in an article never calls this.
 */
export function applyGrade(
  word: { box: number; status: WordStatus },
  grade: LearningGrade,
  now: number,
): GradeResult {
  if (grade === "again") {
    return { box: 0, dueAt: now + INTERVALS_MS[0], status: "learning", correct: false };
  }

  if (grade === "hard") {
    const box = clampBox(word.box);
    return { box, dueAt: now + INTERVALS_MS[box], status: "learning", correct: false };
  }

  const box = clampBox(word.box);
  if (box >= MAX_BOX) {
    return { box: MAX_BOX, dueAt: null, status: "mastered", correct: true };
  }
  const next = box + 1;
  return { box: next, dueAt: now + INTERVALS_MS[next], status: "learning", correct: true };
}

function clampBox(box: number): number {
  if (!Number.isFinite(box)) return 0;
  return Math.min(MAX_BOX, Math.max(0, Math.trunc(box)));
}

export function isDue(word: { status: WordStatus; dueAt: number | null }, now: number): boolean {
  return word.status === "learning" && word.dueAt !== null && word.dueAt <= now;
}

export function dueCount(
  words: Array<{ status: WordStatus; dueAt: number | null }>,
  now: number,
): number {
  return words.reduce((total, word) => (isDue(word, now) ? total + 1 : total), 0);
}

/** Human-readable due label, e.g. "10 分钟后" / "明天" / "已毕业". */
export function formatDueLabel(dueAt: number | null, now: number): string {
  if (dueAt === null) return "已毕业";
  const diff = dueAt - now;
  if (diff <= 0) return "现在";
  if (diff < HOUR) return `${Math.ceil(diff / MINUTE)} 分钟后`;
  if (diff < DAY) return `${Math.ceil(diff / HOUR)} 小时后`;
  if (diff < 2 * DAY) return "明天";
  return `${Math.ceil(diff / DAY)} 天后`;
}
