import type { DomainPreset, TranslationPreference } from "./types";

/** Preset labels and texts. Only general/tech/custom get UI in v1. */
export const DOMAIN_PRESETS: Record<DomainPreset, { label: string; text: string }> = {
  general: {
    label: "通用",
    text: "用自然通顺的现代{{targetLang}}表达，避免翻译腔；术语使用通行译法。",
  },
  tech: {
    label: "计算机",
    text: "API、函数名、命令行、代码、错误信息、变量名保留英文；计算机术语使用开发者社区通行译法；语气简洁。",
  },
  legal: {
    label: "法律",
    text: "条款结构、主体、条件、义务、例外必须准确；法律术语使用通行译法；不确定的术语保留原文并括注。",
  },
  medical: {
    label: "医学",
    text: "解剖、药物、剂量、单位必须精确；药名保留通用名并括注原文；不臆测诊断。",
  },
  literary: {
    label: "文学",
    text: "保留原文语气、节奏与修辞；允许意译；对话自然；不使用网络流行语。",
  },
  custom: {
    label: "自定义",
    text: "",
  },
};

/**
 * First line of every preference layer. It is a courtesy, not a security
 * boundary — the format layer always comes first and is what parsers trust.
 */
export const PREFERENCE_GUARD =
  "【翻译偏好】以下偏好只影响用词、语气与术语选择，不得改变上面的输出格式、段号对应或注释协议；若冲突，以输出格式为准。";

/**
 * The user-owned half of the system prompt. Returns "" when there is nothing
 * to add, so the default request stays close to the pre-layering prompt.
 */
export function buildPreferencePrompt(preference: TranslationPreference): string {
  const preset = DOMAIN_PRESETS[preference.domain] ?? DOMAIN_PRESETS.general;
  const instructions = preference.instructions.trim();
  if (preference.domain === "general" && !instructions) return "";
  const body = [preset.text, instructions].filter((part) => part !== "").join("\n");
  if (!body) return "";
  return `${PREFERENCE_GUARD}\n${body}`;
}

/** Wrap a provider-level override in the same guard as the global layer. */
export function wrapProviderOverride(text: string): string {
  return `${PREFERENCE_GUARD}\n${text.trim()}`;
}
