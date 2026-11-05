/**
 * Rough token estimation for budgeting. This is a heuristic, not a tokenizer:
 * CJK characters are billed at ~1.5 chars/token, everything else at ~4.
 */

const CJK_RE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  const cjk = (text.match(CJK_RE) ?? []).length;
  const other = text.length - cjk;

  return Math.max(0, Math.ceil(cjk / 1.5 + other / 4));
}
