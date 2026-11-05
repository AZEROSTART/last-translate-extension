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
});
