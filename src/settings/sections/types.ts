import type { Settings } from "../../shared/types";

export type SectionId = "model" | "translation" | "learning" | "advanced" | "maintenance";

export interface SettingsContext {
  getSettings(): Settings;
  savePatch(patch: Partial<Settings>): Promise<void>;
  openModels(startNew?: boolean): void;
  /** The http(s) hostname of the active tab, when the popup has one. */
  readonly currentHost?: string;
}

export interface SectionHandle {
  id: SectionId;
  element: HTMLElement;
  summary(): string;
  update(settings: Settings): void;
}
