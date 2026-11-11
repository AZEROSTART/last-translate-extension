/**
 * Prompt assembly and response parsing for paragraph translation.
 * Pure functions only: no DOM, no `chrome.*`, no network.
 */

import type { ChatMessage, GlossaryNote } from "./types";
import { estimateTokens } from "./token-estimate";

/** Line that separates translations from optional glossary annotations. */
export const GLOSSARY_MARKER = "<<<ILMT_GLOSSARY>>>";

/**
 * Appended to the user's translation prompt when hover annotations are on.
 * The marker and JSON shape are a contract with the response parser; changing
 * either requires a prompt-version bump (the prompt hash handles that).
 */
export const GLOSSARY_INSTRUCTIONS = `另外，从每段原文中挑出 0～3 个最值得学习的词或短语，给出它在当前句子里的 {{targetLang}} 释义。宁少勿多；没有合适内容就留空。
在全部译文之后另起一行输出 ${GLOSSARY_MARKER}，下一行只输出一个 JSON 对象，键是译文里的段号（字符串），值是该段的注释数组：
{"1":[{"surface":"原文中的词或短语","pos":"词性，可省略","meaning":"当前语境下的释义","example":"原文中的短例句，可省略"}]}
规则：surface 必须逐字出现在对应段原文中；不要输出音标；不要解释协议；JSON 必须是单行合法对象。`;

/** Append the glossary protocol once, or leave the base prompt untouched. */
export function buildEffectiveSystemPrompt(systemPrompt: string, glossaryEnabled: boolean): string {
  if (!glossaryEnabled || systemPrompt.includes(GLOSSARY_MARKER)) return systemPrompt;
  return systemPrompt ? `${systemPrompt}\n\n${GLOSSARY_INSTRUCTIONS}` : GLOSSARY_INSTRUCTIONS;
}

/**
 * Lowercase SHA-256 hex of the effective system prompt. Used as the cache
 * `promptVersion`; identical prompt text must always yield the same value.
 */
export async function promptVersionFor(systemPrompt: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(systemPrompt),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface Segment {
  id: string;
  text: string;
}

/** Thrown when a model response cannot be mapped onto the requested ids. */
export class PromptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptParseError";
  }
}

/**
 * Split items into batches that fit both limits, preserving order.
 * A single item larger than the token budget still gets its own group so
 * nothing is ever dropped.
 */
export function groupSegments<T extends Segment>(
  items: T[],
  opts: { maxInputTokens: number; maxItems: number },
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let tokens = 0;

  for (const item of items) {
    const cost = estimateTokens(item.text);
    const overItems = current.length >= opts.maxItems;
    const overTokens = current.length > 0 && tokens + cost > opts.maxInputTokens;

    if (overItems || overTokens) {
      if (current.length > 0) groups.push(current);
      current = [];
      tokens = 0;
    }

    current.push(item);
    tokens += cost;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Build the chat messages for one batch. Segment text only ever lands in the
 * user message; the system prompt carries instructions.
 */
export function buildTranslateMessages(
  items: Segment[],
  targetLang: string,
  systemPrompt: string,
): ChatMessage[] {
  const system = systemPrompt.replaceAll("{{targetLang}}", targetLang);
  const user = items.map((item, i) => `[${i + 1}] ${item.text}`).join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const FENCE_RE = /^[ \t]*```[^\n]*$/gm;
const NUMBERED_RE = /^\[(\d+)\]\s*([\s\S]*?)(?=^\[\d+\]|(?![\s\S]))/gm;

/**
 * Map a model's `[n] text` response onto `expectedIds`.
 *
 * Strict on purpose: missing ids, duplicate indices, and out-of-range indices
 * all throw. Callers rely on an all-or-nothing result, never a partial map.
 */
export function parseNumberedResponse(raw: string, expectedIds: string[]): Map<string, string> {
  const body = raw.replace(FENCE_RE, "");
  const byIndex = new Map<number, string>();

  for (const match of body.matchAll(NUMBERED_RE)) {
    const index = Number(match[1]);
    const text = match[2].trim();

    if (byIndex.has(index)) {
      throw new PromptParseError(`Duplicate segment index [${index}] in model response`);
    }
    byIndex.set(index, text);
  }

  for (const index of byIndex.keys()) {
    if (index < 1 || index > expectedIds.length) {
      throw new PromptParseError(
        `Segment index [${index}] is out of range for ${expectedIds.length} expected segment(s)`,
      );
    }
  }

  const result = new Map<string, string>();
  for (let i = 0; i < expectedIds.length; i += 1) {
    const text = byIndex.get(i + 1);
    if (text === undefined) {
      throw new PromptParseError(`Missing segment [${i + 1}] in model response`);
    }
    result.set(expectedIds[i], text);
  }

  return result;
}

const MAX_GLOSSARY_NOTES = 3;
const ASCII_WORD_RE = /[A-Za-z0-9_]/;

function normalizeSurface(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && ASCII_WORD_RE.test(char);
}

/**
 * Whether `surface` occurs in `text` as a whole token. CJK surfaces only need
 * an exact substring; ASCII surfaces additionally need non-word boundaries so
 * a note for "the" cannot match inside "their".
 */
function containsSurface(text: string, surface: string): boolean {
  const haystack = text.toLowerCase().replace(/\s+/g, " ");
  const needle = surface.toLowerCase().replace(/\s+/g, " ");
  if (!needle) return false;

  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after =
      index + needle.length < haystack.length ? haystack[index + needle.length] : undefined;
    const startsOnWord = isAsciiWordChar(needle[0]);
    const endsOnWord = isAsciiWordChar(needle[needle.length - 1]);
    const boundaryOk =
      !(startsOnWord && isAsciiWordChar(before)) && !(endsOnWord && isAsciiWordChar(after));
    if (boundaryOk) return true;
    from = index + 1;
  }
  return false;
}

function stripFences(raw: string): string {
  return raw.replace(FENCE_RE, "").trim();
}

/** Parse the first JSON object in a response, returning null on any failure. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const body = stripFences(raw);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(body.slice(start, end + 1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Validate and normalize the model's glossary object. Every failure is
 * non-fatal: invalid keys, unknown surfaces, duplicates, malformed entries and
 * excess notes are simply dropped. The result only contains non-empty arrays.
 */
export function parseGlossaryNotes(raw: string, items: Segment[]): Map<string, GlossaryNote[]> {
  const result = new Map<string, GlossaryNote[]>();
  const parsed = parseJsonObject(raw);
  if (!parsed) return result;

  for (const [key, value] of Object.entries(parsed)) {
    if (!/^\d+$/.test(key)) continue;
    const index = Number(key);
    if (index < 1 || index > items.length) continue;
    if (!Array.isArray(value)) continue;

    const item = items[index - 1];
    const seen = new Set<string>();
    const notes: GlossaryNote[] = [];

    for (const entry of value) {
      if (notes.length >= MAX_GLOSSARY_NOTES) break;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;

      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.surface !== "string" || typeof candidate.meaning !== "string") continue;

      const surface = normalizeSurface(candidate.surface);
      const meaning = candidate.meaning.trim();
      if (!surface || !meaning || !containsSurface(item.text, surface)) continue;

      const dedupeKey = surface.toLowerCase();
      if (seen.has(dedupeKey)) continue;

      const note: GlossaryNote = { surface, meaning };
      if (typeof candidate.pos === "string" && candidate.pos.trim()) {
        note.pos = candidate.pos.trim();
      }
      if (typeof candidate.example === "string" && candidate.example.trim()) {
        note.example = candidate.example.trim();
      }

      seen.add(dedupeKey);
      notes.push(note);
    }

    if (notes.length > 0) result.set(item.id, notes);
  }

  return result;
}

export interface AnnotatedParseResult {
  translations: Map<string, string>;
  glossary: Map<string, GlossaryNote[]>;
}

/**
 * Split a trailing raw JSON object from a response when the model forgot the
 * marker. Only a complete object at a whitespace boundary is considered.
 */
function splitTrailingGlossaryJson(raw: string): { text: string; notesRaw: string } {
  const body = raw.trimEnd();
  const starts: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "{") continue;
    if (i === 0 || /\s/.test(body[i - 1])) starts.push(i);
  }

  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i];
    const suffix = body.slice(start);
    try {
      const value: unknown = JSON.parse(suffix);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return { text: body.slice(0, start).trimEnd(), notesRaw: suffix };
      }
    } catch {
      // Try an earlier brace; a translation may contain a literal `{`.
    }
  }

  return { text: raw, notesRaw: "" };
}

/**
 * Parse translations plus optional annotations. Translation parsing remains
 * strict; any glossary failure degrades to an empty map.
 */
export function parseAnnotatedResponse(raw: string, items: Segment[]): AnnotatedParseResult {
  const ids = items.map((item) => item.id);
  const markerIndex = raw.indexOf(GLOSSARY_MARKER);

  let translationRaw = raw;
  let notesRaw = "";
  if (markerIndex >= 0) {
    translationRaw = raw.slice(0, markerIndex);
    notesRaw = raw.slice(markerIndex + GLOSSARY_MARKER.length);
  } else {
    const split = splitTrailingGlossaryJson(raw);
    if (split.notesRaw) {
      translationRaw = split.text;
      notesRaw = split.notesRaw;
    }
  }

  const translations = parseNumberedResponse(translationRaw, ids);
  const glossary = notesRaw.trim() ? parseGlossaryNotes(notesRaw, items) : new Map<string, GlossaryNote[]>();
  return { translations, glossary };
}
