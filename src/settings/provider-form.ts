/**
 * Pure helpers for the options page. No DOM, no `chrome.*`, no network — this
 * module is unit-tested directly and shared by the options UI.
 */

import type { ErrorCode, ProviderConfig } from "../shared/types";

export interface ProviderOverridesForm {
  concurrency?: number | "";
  maxRPS?: number | "";
  temperature?: number | "";
  systemPrompt?: string;
}

/**
 * Form representation of a provider. Numeric override fields may be empty
 * ("inherit global"), which is why they widen the persisted number types.
 */
export interface ProviderFormState extends Omit<ProviderConfig, "overrides"> {
  overrides?: ProviderOverridesForm;
}

/** Field codes that are required before a provider can be saved. */
export function validateProvider(provider: ProviderConfig): string[] {
  const missing: string[] = [];
  if (provider.kind !== "deepseek" && !provider.baseURL.trim()) missing.push("baseURL");
  if (!provider.apiKey.trim()) missing.push("apiKey");
  if (!provider.model.trim()) missing.push("model");
  return missing;
}

/**
 * Never render a full key. Long keys keep their last four characters behind a
 * fixed `sk-****` prefix; short keys reveal nothing at all.
 */
export function maskKey(key: string): string {
  if (key === "") return "";
  if (key.length <= 4) return "****";
  return `sk-****${key.slice(-4)}`;
}

function asNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampInt(value: number | string | undefined, min: number, max: number): number | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined) return undefined;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.trim();
    if (!name) continue;
    result[name] = value;
    if (Object.keys(result).length >= 5) break;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Merge a form patch into a provider and return a persistable config.
 *
 * Blank override fields are dropped (inherit global), numeric overrides are
 * clamped, and at most five non-empty extra headers survive.
 */
export function applyProviderForm(
  state: ProviderFormState,
  patch: Partial<ProviderFormState>,
): ProviderConfig {
  const merged: ProviderFormState = {
    ...state,
    ...patch,
    extraHeaders: patch.extraHeaders !== undefined ? patch.extraHeaders : state.extraHeaders,
    overrides: { ...state.overrides, ...patch.overrides },
  };

  const result: ProviderConfig = {
    ...merged,
    overrides: undefined,
    extraHeaders: undefined,
  };

  const headers = sanitizeHeaders(merged.extraHeaders);
  if (headers) result.extraHeaders = headers;

  const candidates = merged.overrides ?? {};
  const overrides: NonNullable<ProviderConfig["overrides"]> = {};

  const concurrency = clampInt(candidates.concurrency, 1, 10);
  if (concurrency !== undefined) overrides.concurrency = concurrency;

  const maxRPS = clampInt(candidates.maxRPS, 1, 20);
  if (maxRPS !== undefined) overrides.maxRPS = maxRPS;

  const temperature = asNumber(candidates.temperature);
  if (temperature !== undefined) overrides.temperature = temperature;

  const systemPrompt =
    typeof candidates.systemPrompt === "string" && candidates.systemPrompt.trim() !== ""
      ? candidates.systemPrompt
      : undefined;
  if (systemPrompt !== undefined) overrides.systemPrompt = systemPrompt;

  if (Object.keys(overrides).length > 0) result.overrides = overrides;
  return result;
}

const ERROR_LABELS: Record<ErrorCode, string> = {
  auth: "认证失败",
  rate_limit: "请求过于频繁",
  timeout: "请求超时",
  network: "网络错误",
  bad_response: "响应格式错误",
  aborted: "已取消",
  unknown: "未知错误",
};

/** Chinese, key-free label for a normalized provider error code. */
export function errorLabel(code: ErrorCode): string {
  return ERROR_LABELS[code] ?? "未知错误";
}
