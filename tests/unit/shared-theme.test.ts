import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDocumentTheme,
  detectPageTheme,
  normalizeThemePreference,
  resolveTheme,
  systemPrefersDark,
} from "../../src/shared/theme";

beforeEach(() => {
  document.documentElement.removeAttribute("style");
  document.body?.removeAttribute("style");
  document.documentElement.dataset.theme = "quantum";
  delete document.documentElement.dataset.themeMode;
});

describe("theme preference resolution", () => {
  it("normalizes only the three known values and defaults to system", () => {
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("system")).toBe("system");
    for (const bad of ["auto", "", null, 1, undefined]) {
      expect(normalizeThemePreference(bad)).toBe("system");
    }
  });

  it("resolves explicit preferences before the system flag", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("survives a window without matchMedia", () => {
    expect(systemPrefersDark(null)).toBe(false);
    expect(systemPrefersDark({} as Window)).toBe(false);
  });
});

describe("applyDocumentTheme", () => {
  it("sets only data-theme-mode and preserves data-theme=quantum", () => {
    const resolved = applyDocumentTheme(document, "light");

    expect(resolved).toBe("light");
    expect(document.documentElement.dataset.themeMode).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("quantum");
  });
});

describe("detectPageTheme", () => {
  it("honors explicit light and dark preferences", () => {
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    expect(detectPageTheme(document, "light")).toBe("light");
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    expect(detectPageTheme(document, "dark")).toBe("dark");
  });

  it("reads an opaque dark body", () => {
    document.body.style.backgroundColor = "rgb(18, 22, 28)";
    expect(detectPageTheme(document, "system")).toBe("dark");
  });

  it("reads an opaque light body", () => {
    document.body.style.backgroundColor = "rgb(250, 250, 250)";
    expect(detectPageTheme(document, "system")).toBe("light");
  });

  it("falls through a transparent body to a dark documentElement", () => {
    document.body.style.backgroundColor = "transparent";
    document.documentElement.style.backgroundColor = "rgb(18, 22, 28)";
    expect(detectPageTheme(document, "system")).toBe("dark");
  });

  it("accepts CSS Color 4 space-separated syntax", () => {
    document.body.style.backgroundColor = "rgb(18 22 28 / 1)";
    expect(detectPageTheme(document, "system")).toBe("dark");
  });

  it("ignores fully transparent colors and falls back to matchMedia", () => {
    document.body.style.backgroundColor = "rgba(0, 0, 0, 0)";
    document.documentElement.style.backgroundColor = "rgba(255, 255, 255, 0)";
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    try {
      expect(detectPageTheme(document, "system")).toBe("dark");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
