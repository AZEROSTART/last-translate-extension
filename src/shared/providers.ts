/**
 * Centralized provider presets and provider-kind vocabulary. No DOM, no
 * `chrome.*`, no network — this module is unit-tested and shared by the UI.
 */

import type { ProviderKind } from "./types";

export const DEEPSEEK_PRESET = {
  name: "DeepSeek",
  baseURL: "https://api.deepseek.com",
  appendV1: false,
  defaultModel: "deepseek-flash",
  fallbackModels: ["deepseek-flash", "deepseek-v4-pro"],
} as const;

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  deepseek: "DeepSeek",
  custom: "自定义 OpenAI 兼容",
};

/** Missing or unknown stored values are legacy custom providers. */
export function normalizeProviderKind(value: unknown): ProviderKind {
  return value === "deepseek" ? "deepseek" : "custom";
}
