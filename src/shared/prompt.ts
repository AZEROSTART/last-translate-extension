/**
 * Prompt assembly and response parsing for paragraph translation.
 * Pure functions only: no DOM, no `chrome.*`, no network.
 */

import type { ChatMessage } from "./types";
import { estimateTokens } from "./token-estimate";

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
