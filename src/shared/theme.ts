/**
 * Theme preference resolution shared by the popup, side panel and hover card.
 * Pure except for the two DOM helpers, which only set one data attribute and
 * never touch the visual `data-theme="quantum"` marker.
 */

import type { Settings } from "./types";

export type ThemePreference = Settings["theme"];
export type ResolvedTheme = "light" | "dark";

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return prefersDark ? "dark" : "light";
}

export function systemPrefersDark(win?: Window | null): boolean {
  try {
    return Boolean(win?.matchMedia?.("(prefers-color-scheme: dark)").matches);
  } catch {
    return false;
  }
}

/** Resolve now, reflect it as `data-theme-mode`, and leave `data-theme` alone. */
export function applyDocumentTheme(doc: Document, pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref, systemPrefersDark(doc.defaultView));
  doc.documentElement.dataset.themeMode = resolved;
  return resolved;
}

interface ParsedColor {
  alpha: number;
  luminance: number;
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Parse comma-separated and CSS Color 4 space-separated rgb/rgba syntax. */
function parseCssColor(raw: string): ParsedColor | null {
  const match = /^rgba?\((.+)\)$/i.exec(raw.trim());
  if (!match) return null;
  const body = match[1];
  let channels: number[];
  let alpha = 1;
  if (body.includes(",")) {
    const parts = body.split(",").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    channels = parts.slice(0, 3).map(Number);
    if (parts.length === 4) alpha = Number(parts[3]);
  } else {
    const [main, alphaPart] = body.split("/").map((part) => part.trim());
    const parts = main.split(/\s+/).filter(Boolean);
    if (parts.length !== 3) return null;
    channels = parts.map(Number);
    if (alphaPart !== undefined) alpha = Number(alphaPart);
  }
  if (channels.some((value) => !Number.isFinite(value))) return null;
  if (!Number.isFinite(alpha)) return null;
  const [r, g, b] = channels;
  return {
    alpha,
    luminance:
      0.2126 * channelLuminance(r) +
      0.7152 * channelLuminance(g) +
      0.0722 * channelLuminance(b),
  };
}

/**
 * The page's own paper wins over the OS: explicit preferences win outright,
 * then an opaque body/document background, then `prefers-color-scheme`.
 */
export function detectPageTheme(doc: Document, pref: ThemePreference): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  const view = doc.defaultView;
  for (const element of [doc.body, doc.documentElement]) {
    if (!element) continue;
    let background = "";
    try {
      background = view?.getComputedStyle?.(element).backgroundColor ?? "";
    } catch {
      continue;
    }
    if (!background || background === "transparent") continue;
    const color = parseCssColor(background);
    if (!color || color.alpha <= 0) continue;
    return color.luminance < 0.2 ? "dark" : "light";
  }
  return systemPrefersDark(view) ? "dark" : "light";
}

export function watchSystemTheme(
  win: Window | null | undefined,
  onChange: () => void,
): () => void {
  try {
    const query = win?.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return () => {};
    const listener = (): void => onChange();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    }
    const legacy = query as MediaQueryList & {
      addListener?: (callback: () => void) => void;
      removeListener?: (callback: () => void) => void;
    };
    legacy.addListener?.(listener);
    return () => legacy.removeListener?.(listener);
  } catch {
    return () => {};
  }
}
