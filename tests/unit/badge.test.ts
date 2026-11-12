import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeText, refreshBadge } from "../../src/background/badge";
import { emptyLearningState, mergeLearnedWord } from "../../src/shared/learning-storage";

const NOW = 1_700_000_000_000;

beforeEach(() => chrome.storage.local.clear());
afterEach(() => vi.unstubAllGlobals());

function stubAction() {
  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  const setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { ...chrome, action: { setBadgeText, setBadgeBackgroundColor } });
  return { setBadgeText, setBadgeBackgroundColor };
}

describe("badgeText", () => {
  it("formats badge text", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(1)).toBe("1");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(120)).toBe("99+");
  });
});

describe("refreshBadge", () => {
  it("clears the badge when nothing is due", async () => {
    const { setBadgeText } = stubAction();
    await refreshBadge(NOW);
    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("shows the due count and tints the badge", async () => {
    const { setBadgeText, setBadgeBackgroundColor } = stubAction();
    const due = mergeLearnedWord(
      emptyLearningState(),
      {
        type: "learn-word",
        surface: "outlive",
        termLang: "en",
        glossLang: "zh",
        meaning: "m",
        sentence: "s",
        pageUrl: "https://x",
      },
      NOW,
    ).state;
    // A card due tomorrow is not counted today.
    await chrome.storage.local.set({ learning: due });
    await refreshBadge(NOW);
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: "" });

    await refreshBadge(NOW + 11 * 60_000);
    expect(setBadgeText).toHaveBeenLastCalledWith({ text: "1" });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#2dd4bf" });
  });
});
