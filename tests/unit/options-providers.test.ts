import { describe, it, expect } from "vitest";
import type { ProviderConfig } from "../../src/shared/types";
import {
  applyProviderForm,
  maskKey,
  promptVersionFor,
  validateProvider,
} from "../../src/options/providers";

const base: ProviderConfig = {
  id: "a",
  name: "A",
  kind: "custom",
  baseURL: "https://x",
  apiKey: "sk-1234567890",
  model: "m",
  createdAt: 1,
};

describe("validateProvider", () => {
  it("requires baseURL, apiKey and model", () => {
    expect(validateProvider({ ...base, baseURL: "" })).toContain("baseURL");
    expect(validateProvider({ ...base, apiKey: "" })).toContain("apiKey");
    expect(validateProvider({ ...base, model: "" })).toContain("model");
    expect(validateProvider(base)).toEqual([]);
  });
});

describe("maskKey", () => {
  it("masks keys to the last four characters", () => {
    expect(maskKey("sk-1234567890")).toBe("sk-****7890");
    expect(maskKey("")).toBe("");
    expect(maskKey("abc")).toBe("****");
  });
});

describe("applyProviderForm", () => {
  it("keeps existing values when the form patch omits them", () => {
    expect(applyProviderForm(base, { model: "m2" })).toMatchObject({
      baseURL: "https://x",
      apiKey: "sk-1234567890",
      model: "m2",
    });
  });

  it("drops blank overrides and clamps numeric overrides", () => {
    const result = applyProviderForm(
      {
        ...base,
        overrides: {
          concurrency: 99,
          maxRPS: 0,
          temperature: "",
          systemPrompt: "   ",
        },
      },
      {},
    );

    expect(result.overrides).toEqual({ concurrency: 10, maxRPS: 1 });
  });

  it("caps extra headers at five entries", () => {
    const result = applyProviderForm(
      {
        ...base,
        extraHeaders: {
          a: "1",
          b: "2",
          c: "3",
          d: "4",
          e: "5",
          f: "6",
        },
      },
      {},
    );

    expect(Object.keys(result.extraHeaders ?? {})).toHaveLength(5);
    expect(result.extraHeaders?.f).toBeUndefined();
  });
});

describe("promptVersionFor", () => {
  it("is stable for identical input", () => {
    expect(promptVersionFor("相同的提示词")).toBe(promptVersionFor("相同的提示词"));
    expect(promptVersionFor("相同的提示词")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when the prompt changes", () => {
    expect(promptVersionFor("提示词 A")).not.toBe(promptVersionFor("提示词 B"));
  });
});
