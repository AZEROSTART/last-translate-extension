/**
 * Personal vocabulary export. Plain text only: a BOM-prefixed CSV a
 * spreadsheet opens correctly, or the stored state as JSON. No network.
 */

import { localDay, primaryMeaning } from "./learning-storage";
import type { LearningState, LearningWord } from "./types";

/**
 * Neutralize a leading formula character, then apply RFC 4180 quoting. Excel
 * and Sheets both treat `=`, `+`, `-`, `@`, tab and carriage return as a
 * formula start unless the cell is prefixed with an apostrophe.
 */
export function escapeCsvCell(raw: string): string {
  let value = raw;
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  if (/[",\r\n]/.test(value)) value = `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function exportLearningCsv(words: readonly LearningWord[], preferredLang?: string): string {
  const header = "word,pos,meaning,language,status,sentence,source_url";
  const rows = words.map((word) => {
    const context = word.contexts.at(-1);
    return [
      word.surface,
      word.pos ?? "",
      primaryMeaning(word, preferredLang),
      word.termLang,
      word.status,
      context?.sentence ?? "",
      context?.pageUrl ?? "",
    ]
      .map((cell) => escapeCsvCell(cell))
      .join(",");
  });
  return `\uFEFF${[header, ...rows].join("\r\n")}`;
}

export function exportLearningJson(state: LearningState): string {
  return JSON.stringify(state, null, 2);
}

export function exportFilename(ext: "csv" | "json", now: number): string {
  return `ilmt-vocabulary-${localDay(now)}.${ext}`;
}
