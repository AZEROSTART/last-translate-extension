import { describe, it, expect } from "vitest";
import themeCss from "../../src/styles/theme.css?inline";

describe("quantum theme", () => {
  it("defines the C palette tokens", () => {
    for (const token of [
      "--ilmt-bg",
      "--ilmt-panel",
      "--ilmt-panel-2",
      "--ilmt-glass",
      "--ilmt-accent",
      "--ilmt-accent-2",
      "--ilmt-text",
      "--ilmt-muted",
      "--ilmt-border",
      "--ilmt-border-soft",
      "--ilmt-input",
    ]) {
      expect(themeCss).toContain(token);
    }
    expect(themeCss).toContain("#04060c");
    expect(themeCss).toContain("#2dd4bf");
    expect(themeCss).toContain("#67e8f9");
    expect(themeCss).toContain("#dffcf7");
  });

  it("disables motion under prefers-reduced-motion", () => {
    expect(themeCss).toContain("prefers-reduced-motion: reduce");
  });
});
