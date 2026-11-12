import type {
  DomainPreset,
  MascotSettings,
  ProviderConfig,
  Settings,
  TranslationPreference,
} from "./types";
import { normalizeProviderKind } from "./providers";

const SETTINGS_KEY = "settings";

/** Languages that may be learning targets; order is the display order. */
export const LEARNING_LANGS = ["en", "ja", "es", "fr"] as const;

const DOMAIN_PRESETS: readonly DomainPreset[] = [
  "general",
  "tech",
  "legal",
  "medical",
  "literary",
  "custom",
];

/** The pre-v2 default prompt; used to tell "untouched" from "user-edited". */
export const LEGACY_DEFAULT_PROMPT =
  "你是一个翻译引擎。把用户给出的编号段落翻译成{{targetLang}}。只输出 [编号] 译文，逐行对应，不解释、不合并、不遗漏。保留原文的专有名词、代码、URL。";

/** Whitelist, de-duplicate, cap at 4, and fall back to ["en"]. */
export function normalizeLearningLangs(value: unknown): string[] {
  if (!Array.isArray(value)) return ["en"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const lang = item.trim().toLowerCase();
    if (!(LEARNING_LANGS as readonly string[]).includes(lang)) continue;
    if (seen.has(lang)) continue;
    seen.add(lang);
    out.push(lang);
    if (out.length === LEARNING_LANGS.length) break;
  }
  return out.length > 0 ? out : ["en"];
}

function normalizeInstructions(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

/** Read a valid stored preference; otherwise migrate the legacy system prompt. */
export function normalizePreference(
  value: unknown,
  legacySystemPrompt?: unknown,
): TranslationPreference {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as { domain?: unknown; instructions?: unknown };
    if (typeof raw.domain === "string" && DOMAIN_PRESETS.includes(raw.domain as DomainPreset)) {
      return {
        domain: raw.domain as DomainPreset,
        instructions: normalizeInstructions(raw.instructions),
      };
    }
  }

  const prompt = typeof legacySystemPrompt === "string" ? legacySystemPrompt.trim() : "";
  if (!prompt || prompt === LEGACY_DEFAULT_PROMPT) {
    return { domain: "general", instructions: "" };
  }
  const rest = prompt.startsWith(LEGACY_DEFAULT_PROMPT)
    ? prompt.slice(LEGACY_DEFAULT_PROMPT.length).trim()
    : prompt;
  return { domain: "custom", instructions: normalizeInstructions(rest) };
}

export function normalizeMascot(value: unknown): MascotSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mode: "rotate", enabledIds: [], animations: true };
  }
  const raw = value as {
    mode?: unknown;
    fixedId?: unknown;
    enabledIds?: unknown;
    animations?: unknown;
  };
  const enabledIds = Array.isArray(raw.enabledIds)
    ? raw.enabledIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const mode = raw.mode === "fixed" ? "fixed" : "rotate";
  return {
    mode,
    ...(typeof raw.fixedId === "string" && raw.fixedId ? { fixedId: raw.fixedId } : {}),
    enabledIds,
    animations: raw.animations !== false,
  };
}

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
  systemPrompt: LEGACY_DEFAULT_PROMPT,
  promptVersion: "",
  reviewAnswerLang: "",
  triggerMode: "shortcut",
  siteRules: {},
  theme: "system",
  glossaryEnabled: true,
  minParagraphLength: 10,
  contentOnly: true,
  learningLangs: ["en"],
  preference: { domain: "general", instructions: "" },
  mascot: { mode: "rotate", enabledIds: [], animations: true },
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

  // Granularity is on by default. Malformed stored values must not turn all
  // page text back on, and a missing min length should use the same default
  // users see in the options page.
  if (
    typeof merged.minParagraphLength !== "number" ||
    !Number.isFinite(merged.minParagraphLength)
  ) {
    merged.minParagraphLength = 10;
  } else {
    merged.minParagraphLength = Math.min(100, Math.max(1, Math.trunc(merged.minParagraphLength)));
  }
  if (typeof merged.contentOnly !== "boolean") {
    merged.contentOnly = true;
  }

  // Learning settings are normalized on every read so a corrupt store never
  // disables annotations or breaks the scheduler.
  merged.learningLangs = normalizeLearningLangs(
    (stored as { learningLangs?: unknown } | undefined)?.learningLangs,
  );
  merged.preference = normalizePreference(
    (stored as { preference?: unknown } | undefined)?.preference,
    (stored as { systemPrompt?: unknown } | undefined)?.systemPrompt,
  );
  merged.mascot = normalizeMascot((stored as { mascot?: unknown } | undefined)?.mascot);
  if (typeof merged.reviewAnswerLang !== "string") merged.reviewAnswerLang = "";

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
