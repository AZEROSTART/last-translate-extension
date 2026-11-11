import type { ProviderConfig, Settings } from "./types";
import { normalizeProviderKind } from "./providers";

const SETTINGS_KEY = "settings";

/**
 * Defaults mirror the spec. `systemPrompt` keeps the literal
 * `{{targetLang}}` placeholder; the prompt builder substitutes it later.
 */
export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: "",
  targetLang: "zh-CN",
  concurrency: 3,
  maxRPS: 5,
  temperature: 0,
  systemPrompt:
    "你是一个翻译引擎。把用户给出的编号段落翻译成{{targetLang}}。只输出 [编号] 译文，逐行对应，不解释、不合并、不遗漏。保留原文的专有名词、代码、URL。",
  promptVersion: "",
  triggerMode: "shortcut",
  siteRules: {},
  theme: "system",
  glossaryEnabled: true,
};

/**
 * Read settings, shallow-merging whatever is stored over the defaults.
 * Unknown stored keys are preserved and missing keys fall back to defaults.
 */
export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as
    | Partial<Settings>
    | undefined;

  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    providers: [...DEFAULT_SETTINGS.providers],
    siteRules: { ...DEFAULT_SETTINGS.siteRules },
    ...(stored ?? {}),
  };

  // Legacy or unknown provider kinds normalize to "custom" on every read;
  // an existing "deepseek" kind is preserved.
  merged.providers = merged.providers.map((provider) => ({
    ...provider,
    kind: normalizeProviderKind((provider as { kind?: unknown }).kind),
  }));

  // Ruling 7: the canonical value is "auto-current-site" (spec §8.10); older
  // builds stored the shorter "auto". Migrate it on every read.
  if ((merged.triggerMode as string) === "auto") {
    merged.triggerMode = "auto-current-site";
  }

  // Glossary annotations are on by default; a missing or malformed value must
  // never disable them by accident.
  if (typeof merged.glossaryEnabled !== "boolean") {
    merged.glossaryEnabled = true;
  }

  return merged;
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

/**
 * Insert or update a provider by id. The first provider added becomes the
 * active one; an existing active provider is never replaced here.
 */
export async function upsertProvider(p: ProviderConfig): Promise<void> {
  const s = await getSettings();
  const exists = s.providers.some((provider) => provider.id === p.id);
  const providers = exists
    ? s.providers.map((provider) => (provider.id === p.id ? p : provider))
    : [...s.providers, p];

  await saveSettings({
    ...s,
    providers,
    activeProviderId: s.activeProviderId || p.id,
  });
}

/** Remove a provider; clear the active id when it pointed at the removed one. */
export async function removeProvider(id: string): Promise<void> {
  const s = await getSettings();
  const providers = s.providers.filter((provider) => provider.id !== id);

  await saveSettings({
    ...s,
    providers,
    activeProviderId: s.activeProviderId === id ? "" : s.activeProviderId,
  });
}

export function getActiveProvider(s: Settings): ProviderConfig | undefined {
  return s.providers.find((provider) => provider.id === s.activeProviderId);
}
