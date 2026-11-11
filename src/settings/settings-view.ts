/**
 * Popup settings controller: four collapsible sections plus the second-level
 * model manager. All section bodies stay mounted so switching accordion
 * sections never discards unsaved input.
 */

import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../shared/storage";
import { buildEffectiveSystemPrompt, promptVersionFor } from "../shared/prompt";
import type { Settings } from "../shared/types";
import { el } from "./components";
import { mountProviderManager, type ProviderManagerHandle } from "./provider-manager";
import { createAdvancedSection } from "./sections/advanced";
import { createMaintenanceSection } from "./sections/maintenance";
import { createModelSection } from "./sections/model";
import { createTranslationSection } from "./sections/translation";
import type { SectionHandle, SettingsContext } from "./sections/types";

export interface SettingsViewOptions {
  mode: "popup" | "page";
}

export interface SettingsViewHandle {
  readonly settings: Settings | null;
  readonly mode: "popup" | "page";
}

export async function createSettingsView(
  host: HTMLElement,
  options: SettingsViewOptions,
): Promise<SettingsViewHandle> {
  let settings: Settings | null = null;
  try {
    settings = await getSettings();
  } catch {
    settings = null;
  }

  const state = settings ? mount(host, settings, options.mode) : null;
  if (!state) {
    host.replaceChildren(
      el("p", "settings-read-error", "读取设置失败，请关闭后重试。"),
    );
  }

  return {
    get settings() {
      return state?.settings ?? null;
    },
    mode: options.mode,
  };
}

function mount(
  host: HTMLElement,
  initialSettings: Settings,
  mode: "popup" | "page",
): { readonly settings: Settings } {
  let settings = initialSettings;
  let providerManager: ProviderManagerHandle | null = null;

  const home = el("div", "settings-home");
  const subHost = el("div", "settings-subview-host");
  subHost.hidden = true;
  host.replaceChildren(home, subHost);

  const ctx: SettingsContext = {
    getSettings: () => settings,
    savePatch,
    openModels,
  };

  const handles: SectionHandle[] = [
    createModelSection(ctx),
    createTranslationSection(ctx),
    createAdvancedSection(ctx),
    createMaintenanceSection(ctx),
  ];
  const modelHandle = handles[0];
  const metaById = new Map<string, HTMLElement>();

  const titles: Record<string, string> = {
    model: "模型设置",
    translation: "翻译设置",
    advanced: "性能与提示词",
    maintenance: "缓存维护",
  };

  for (const handle of handles) {
    const details = el("details", "settings-section");
    details.dataset.section = handle.id;
    const summary = el("summary", "settings-summary");
    const title = el("span", "settings-summary-title", titles[handle.id]);
    const meta = el("span", "settings-summary-meta", handle.summary());
    summary.append(title, meta);
    details.append(summary, handle.element);
    details.open = handle.id === "model";
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      for (const other of Array.from(home.querySelectorAll<HTMLDetailsElement>("details.settings-section"))) {
        if (other !== details) other.open = false;
      }
    });
    metaById.set(handle.id, meta);
    home.appendChild(details);
  }

  function updateSummaries(): void {
    for (const handle of handles) {
      metaById.get(handle.id)!.textContent = handle.summary();
    }
  }

  function refreshAll(): void {
    modelHandle.update(settings);
    updateSummaries();
  }

  async function savePatch(patch: Partial<Settings>): Promise<void> {
    const current = settings;
    const next: Settings = { ...current, ...patch };
    const promptChanged =
      patch.systemPrompt !== undefined && patch.systemPrompt !== current.systemPrompt;
    const glossaryChanged =
      patch.glossaryEnabled !== undefined && patch.glossaryEnabled !== current.glossaryEnabled;
    if (promptChanged || glossaryChanged || next.promptVersion === "") {
      const effective = buildEffectiveSystemPrompt(
        next.systemPrompt.trim() ? next.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
        next.glossaryEnabled,
      );
      next.promptVersion = await promptVersionFor(effective);
    }

    await saveSettings(next);
    settings = await getSettings();
    if (patch.activeProviderId !== undefined) modelHandle.update(settings);
    updateSummaries();
  }

  function openModels(startNew = false): void {
    if (providerManager) return;
    home.hidden = true;
    subHost.hidden = false;
    providerManager = mountProviderManager(subHost, settings, startNew, {
      onBack: closeModels,
      onSettingsChanged(next) {
        settings = next;
        refreshAll();
      },
    });
  }

  function closeModels(): void {
    providerManager = null;
    subHost.replaceChildren();
    subHost.hidden = true;
    home.hidden = false;
    refreshAll();
  }

  void mode;
  return {
    get settings() {
      return settings;
    },
  };
}
