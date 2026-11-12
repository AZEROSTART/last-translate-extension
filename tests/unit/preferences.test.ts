import { describe, it, expect } from "vitest";
import { DOMAIN_PRESETS, buildPreferencePrompt } from "../../src/shared/preferences";
import { buildSystemPrompt } from "../../src/shared/prompt";

describe("buildPreferencePrompt", () => {
  it("omits the preference layer for general with no instructions", () => {
    expect(buildPreferencePrompt({ domain: "general", instructions: "" })).toBe("");
  });

  it("puts the format guard first in the preference layer", () => {
    const text = buildPreferencePrompt({ domain: "tech", instructions: "保留英文术语" });
    expect(text.indexOf("不得改变")).toBeLessThan(text.indexOf("保留英文术语"));
    expect(text).toContain("计算机");
  });

  it("keeps the reserved presets available without exposing them", () => {
    expect(Object.keys(DOMAIN_PRESETS)).toEqual([
      "general",
      "tech",
      "legal",
      "medical",
      "literary",
      "custom",
    ]);
  });

  it("uses only instructions for the custom domain", () => {
    const text = buildPreferencePrompt({ domain: "custom", instructions: "像我朋友那样说话" });
    expect(text).toContain("像我朋友那样说话");
    expect(text).not.toContain("自然通顺");
  });
});

describe("buildSystemPrompt", () => {
  it("keeps the format layer before the preference layer", () => {
    const p = buildSystemPrompt({
      targetLang: "zh-CN",
      glossaryEnabled: false,
      glossLangs: [],
      preference: { domain: "tech", instructions: "保留英文术语" },
    });
    expect(p.indexOf("[编号]")).toBeLessThan(p.indexOf("【翻译偏好】"));
  });

  it("lets a provider override replace only the preference layer", () => {
    const p = buildSystemPrompt({
      targetLang: "zh-CN",
      glossaryEnabled: false,
      glossLangs: [],
      preference: { domain: "tech", instructions: "inner" },
      providerOverride: "只输出英文",
    });
    expect(p).toContain("[编号]");
    expect(p).toContain("只输出英文");
    expect(p).not.toContain("inner");
    expect(p.indexOf("[编号]")).toBeLessThan(p.indexOf("只输出英文"));
  });
});
