import { describe, it, expect } from "vitest";
import { applyGrade, formatDueLabel } from "../../src/shared/srs";

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
