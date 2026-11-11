import { describe, it, expect, beforeEach } from "vitest";
import { getSettings, saveSettings, upsertProvider, removeProvider, getActiveProvider, DEFAULT_SETTINGS } from "../../src/shared/storage";

beforeEach(() => chrome.storage.local.clear());

describe("settings storage", () => {
  it("returns defaults when empty", async () => {
    const s = await getSettings();
    expect(s.targetLang).toBe("zh-CN");
    expect(s.concurrency).toBe(3);
    expect(s.maxRPS).toBe(5);
    expect(s.providers).toEqual([]);
    expect(s.triggerMode).toBe("shortcut");
    expect(s.glossaryEnabled).toBe(true);
  });

  it("preserves an explicit glossaryEnabled false", async () => {
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, glossaryEnabled: false } });
    expect((await getSettings()).glossaryEnabled).toBe(false);
  });

  it("normalizes a non-boolean glossaryEnabled to the default", async () => {
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, glossaryEnabled: "yes" } });
    expect((await getSettings()).glossaryEnabled).toBe(true);
  });

  it("round-trips providers and keeps the active one", async () => {
    await saveSettings(DEFAULT_SETTINGS);
    await upsertProvider({ id: "a", name: "网关", kind: "custom", baseURL: "https://x.test", apiKey: "k", model: "m", createdAt: 1 });
    const s = await getSettings();
    expect(s.providers).toHaveLength(1);
    expect(getActiveProvider(s)?.id).toBe("a");
  });

  it("removes a provider and clears active when it was active", async () => {
    await saveSettings(DEFAULT_SETTINGS);
    await upsertProvider({ id: "a", name: "A", kind: "custom", baseURL: "u", apiKey: "k", model: "m", createdAt: 1 });
    await removeProvider("a");
    const s = await getSettings();
    expect(s.providers).toEqual([]);
    expect(s.activeProviderId).toBe("");
  });

  it("fills missing fields from defaults instead of returning undefined", async () => {
    await chrome.storage.local.set({ settings: { targetLang: "ja" } });
    const s = await getSettings();
    expect(s.targetLang).toBe("ja");
    expect(s.maxRPS).toBe(5);
  });

  it("preserves unknown stored keys while merging over defaults", async () => {
    await chrome.storage.local.set({ settings: { targetLang: "ko", futureOption: true } });
    const s = (await getSettings()) as typeof DEFAULT_SETTINGS & { futureOption: boolean };
    expect(s.targetLang).toBe("ko");
    expect(s.futureOption).toBe(true);
  });

  it("normalizes missing and unknown provider kinds to custom", async () => {
    await chrome.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        providers: [
          { id: "a", name: "A", baseURL: "u", apiKey: "k", model: "m", createdAt: 1 },
          { id: "b", name: "B", kind: "legacy", baseURL: "u", apiKey: "k", model: "m", createdAt: 2 },
          { id: "c", name: "C", kind: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "k", model: "deepseek-flash", createdAt: 3 },
        ],
      },
    });

    const s = await getSettings();
    expect(s.providers.map((p) => p.kind)).toEqual(["custom", "custom", "deepseek"]);
    expect(s.providers[2]).toMatchObject({ name: "C", baseURL: "https://api.deepseek.com" });
  });
});
