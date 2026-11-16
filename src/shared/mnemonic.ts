/**
 * Prompt and cleanup for the review "mnemonic scene": one line of concrete
 * imagery that a claim effect then performs. Pure functions only.
 */

import type { ChatMessage } from "./types";

/** Hard budget for the caption; the scene stage is one short line wide. */
export const MNEMONIC_MAX_CHARS = 40;

const LANG_NAMES: Record<string, string> = {
  zh: "中文",
  en: "英语",
  es: "西班牙语",
  ja: "日语",
  fr: "法语",
  de: "德语",
};

export interface MnemonicInput {
  surface: string;
  termLang: string;
  pos?: string;
  /** Meaning in the review answer language. */
  meaning: string;
  /** The sentence the word was captured from; may be empty. */
  sentence: string;
  /** Language of the caption, e.g. `zh-CN`. */
  lang: string;
}

function langName(lang: string): string {
  return LANG_NAMES[lang.split(/[-_]/)[0].trim().toLowerCase()] ?? lang;
}

export function buildMnemonicPrompt(input: MnemonicInput): ChatMessage[] {
  const system = [
    "你是一个记忆教练。给下面这个外语词写一个「画面钩子」：一行具体的画面，帮人把词义钉在脑子里。",
    `只输出这一行画面，不超过 ${MNEMONIC_MAX_CHARS} 个字，用${langName(input.lang)}。`,
    "必须写清楚谁在做什么，画面可以荒诞，但要能让人想起这个词的意思。",
    "不要解释词义，不要翻译，不要音标，不要引号，不要编号或列表。",
  ].join("\n");

  const lines = [
    `词：${input.surface}（${input.termLang}）`,
    input.pos ? `词性：${input.pos}` : "",
    `当前语境释义：${input.meaning}`,
    input.sentence ? `原句：${input.sentence}` : "",
  ].filter(Boolean);

  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
}

/**
 * Models like to wrap the answer in quotes, bold it, or number it. Keep the
 * sentence itself, drop the furniture, and stay inside the caption budget.
 */
export function sanitizeCaption(raw: string): string {
  let text = raw.trim();
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
  text = text.replace(/^[“"「『']+/, "").replace(/[”"」』']+$/, "");
  text = text.replace(/\s+/g, " ").trim();
  // Empty quote pairs survive the trim above; treat them as no answer.
  if (/^["'「」『』“”]*$/.test(text)) return "";
  return Array.from(text).slice(0, MNEMONIC_MAX_CHARS).join("").trim();
}
