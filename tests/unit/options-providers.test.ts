import { describe, it, expect } from "vitest";
import type { ProviderConfig } from "../../src/shared/types";
import {
  applyProviderForm,
  maskKey,
  promptVersionFor,
  validateProvider,
} from "../../src/settings/provider-form";
import { DEEPSEEK_PRESET } from "../../src/shared/providers";

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

  it("requires only apiKey and model for DeepSeek", () => {
    const deepseek: ProviderConfig = {
      ...base,
      kind: "deepseek",
      baseURL: "",
      apiKey: "",
      model: "",
    };
    expect(validateProvider(deepseek)).toEqual(["apiKey", "model"]);
    expect(validateProvider({ ...deepseek, apiKey: "k", model: "m" })).toEqual([]);
  });
});

describe("DEEPSEEK_PRESET", () => {
  it("exposes the DeepSeek preset values", () => {
    expect(DEEPSEEK_PRESET).toEqual({
      name: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      appendV1: false,
      defaultModel: "deepseek-flash",
      fallbackModels: ["deepseek-flash", "deepseek-v4-pro"],
    });
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

  it("round-trips an explicit appendV1 opt-out", () => {
    expect(applyProviderForm({ ...base, appendV1: false }, {})).toMatchObject({
      baseURL: "https://x",
      appendV1: false,
    });
    expect(applyProviderForm({ ...base, appendV1: false }, { model: "m2" }).appendV1).toBe(false);
  });
});

describe("promptVersionFor", () => {
  it("is stable for identical input and returns a 64-char SHA-256 hex", async () => {
    const first = await promptVersionFor("相同的提示词");
    expect(first).toBe(await promptVersionFor("相同的提示词"));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the prompt changes", async () => {
    expect(await promptVersionFor("提示词 A")).not.toBe(await promptVersionFor("提示词 B"));
  });
});
