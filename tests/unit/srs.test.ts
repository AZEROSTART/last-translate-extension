import { describe, it, expect, vi } from "vitest";
import { applyGrade, formatDueLabel, previewDueLabel } from "../../src/shared/srs";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe("applyGrade", () => {
  it("maps good to the next box and its interval", () => {
    expect(applyGrade({ box: 0, status: "learning" }, "good", NOW)).toEqual({
      box: 1,
      dueAt: NOW + 24 * HOUR,
      status: "learning",
      correct: true,
    });
  });

  it("keeps the box on hard and re-arms the same interval", () => {
    expect(applyGrade({ box: 3, status: "learning" }, "hard", NOW)).toEqual({
      box: 3,
      dueAt: NOW + 7 * 24 * HOUR,
      status: "learning",
      correct: false,
    });
  });

  it("drops to box 0 with a ten-minute retry on again", () => {
    expect(applyGrade({ box: 4, status: "learning" }, "again", NOW)).toEqual({
      box: 0,
      dueAt: NOW + 10 * 60_000,
      status: "learning",
      correct: false,
    });
  });

  it("graduates after a good answer at the top box", () => {
    expect(applyGrade({ box: 5, status: "learning" }, "good", NOW)).toEqual({
      box: 5,
      dueAt: null,
      status: "mastered",
      correct: true,
    });
  });
});

describe("formatDueLabel", () => {
  it("formats due labels", () => {
    expect(formatDueLabel(NOW + 10 * 60_000, NOW)).toBe("10 分钟后");
    expect(formatDueLabel(NOW + 3 * HOUR, NOW)).toBe("3 小时后");
    expect(formatDueLabel(NOW + 24 * HOUR, NOW)).toBe("明天");
    expect(formatDueLabel(NOW + 3 * 24 * HOUR, NOW)).toBe("3 天后");
    expect(formatDueLabel(null, NOW)).toBe("已毕业");
    expect(formatDueLabel(NOW - 1, NOW)).toBe("现在");
  });
});

describe("previewDueLabel", () => {
  const word = (box: number) =>
    ({ box, status: "learning" as const, dueAt: NOW - 1, surface: "outlive" });

  it("previews both retry grades and tomorrow for the first good grade", () => {
    const fresh = word(0);
    expect(previewDueLabel(fresh, "again", NOW)).toBe("10 分钟后");
    expect(previewDueLabel(fresh, "hard", NOW)).toBe("10 分钟后");
    expect(previewDueLabel(fresh, "good", NOW)).toBe("明天");
  });

  it("walks the same interval table as applyGrade", () => {
    const box2 = word(2);
    expect(previewDueLabel(box2, "again", NOW)).toBe("10 分钟后");
    expect(previewDueLabel(box2, "hard", NOW)).toBe("3 天后");
    expect(previewDueLabel(box2, "good", NOW)).toBe("7 天后");
    // `good` advances a box, so 16 天后 is the preview from box 3.
    expect(previewDueLabel(word(3), "good", NOW)).toBe("16 天后");
    expect(previewDueLabel(word(4), "good", NOW)).toBe("35 天后");
  });

  it("says 已毕业 at the top box, matching applyGrade", () => {
    expect(previewDueLabel(word(5), "good", NOW)).toBe("已毕业");
    expect(applyGrade({ box: 5, status: "learning" }, "good", NOW)).toEqual({
      box: 5,
      dueAt: null,
      status: "mastered",
      correct: true,
    });
  });

  it("never mutates the word and never touches storage", () => {
    const target = word(3);
    const snapshot = structuredClone(target);
    const get = vi.spyOn(chrome.storage.local, "get");
    const set = vi.spyOn(chrome.storage.local, "set");

    previewDueLabel(target, "again", NOW);
    previewDueLabel(target, "good", NOW);

    expect(target).toEqual(snapshot);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
  });
});
