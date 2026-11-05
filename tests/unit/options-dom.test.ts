import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ProviderConfig, Settings } from "../../src/shared/types";
import { DEFAULT_SETTINGS, getSettings } from "../../src/shared/storage";
import { ProviderError } from "../../src/shared/errors";
import { buildCacheKey, TranslationCache } from "../../src/background/cache";
import { promptVersionFor } from "../../src/options/providers";

vi.mock("../../src/providers", () => ({
  listModels: vi.fn(),
  complete: vi.fn(),
}));

interface ProvidersMock {
  listModels: Mock;
  complete: Mock;
}

const p1: ProviderConfig = {
  id: "p1",
  name: "官方配置",
  kind: "custom",
  baseURL: "https://api.test",
  apiKey: "sk-1234567890",
  model: "gpt-4o",
  createdAt: 1,
};

const p2: ProviderConfig = {
  id: "p2",
  name: "备用配置",
  kind: "custom",
  baseURL: "https://backup.test",
  apiKey: "backup-key-5678",
  model: "backup-model",
  createdAt: 2,
};

function settingsWith(partial: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providers: [],
    siteRules: {},
    ...partial,
  };
}

async function seed(partial: Partial<Settings> = {}): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ settings: settingsWith(partial) });
}

async function boot(): Promise<ProvidersMock> {
  const providers = (await import("../../src/providers")) as unknown as ProvidersMock;
  await import("../../src/options/main");
  await (globalThis as unknown as { __ilmtOptions: { ready: Promise<void> } }).__ilmtOptions.ready;
  return providers;
}

function click(selector: string, root: ParentNode = document): void {
  const el = root.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

function setValue(
  selector: string,
  value: string,
  root: ParentNode = document,
): void {
  const el = root.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) throw new Error(`missing ${selector}`);
  el.value = value;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = `<div id="root"></div>`;
  delete (globalThis as unknown as { __ilmtOptions?: unknown }).__ilmtOptions;
  await chrome.storage.local.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.querySelectorAll("style[data-ilmt-options]").forEach((el) => el.remove());
  delete (globalThis as unknown as { __ilmtOptions?: unknown }).__ilmtOptions;
});

describe("provider list", () => {
  it("renders existing providers with masked keys", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    expect(document.querySelectorAll(".provider-card")).toHaveLength(1);
    const text = document.querySelector(".provider-list")?.textContent ?? "";
    expect(text).toContain(p1.name);
    expect(text).toContain(p1.baseURL);
    expect(text).toContain(p1.model);
    expect(text).toContain("sk-****7890");
    expect(document.body.textContent).not.toContain(p1.apiKey);
  });

  it("adds a provider and writes it to storage with clamped overrides", async () => {
    await seed();
    await boot();

    click(".provider-add");
    setValue(".pf-name", "新配置");
    setValue(".pf-baseURL", "https://new.test");
    setValue(".pf-apiKey", "sk-1234567890");
    setValue(".pf-model", "model-x");
    setValue(".pf-concurrency", "99");
    setValue(".pf-maxRPS", "0");
    click(".pf-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(1);
    });

    const s = await getSettings();
    expect(s.providers[0]).toMatchObject({
      name: "新配置",
      baseURL: "https://new.test",
      model: "model-x",
      apiKey: "sk-1234567890",
    });
    expect(s.providers[0].overrides).toEqual({ concurrency: 10, maxRPS: 1 });
    expect(s.activeProviderId).toBe(s.providers[0].id);
  });

  it("edits a provider without exposing or replacing the stored key", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    click(".provider-edit");
    const keyInput = document.querySelector(".pf-apiKey") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(document.body.textContent).not.toContain(p1.apiKey);

    setValue(".pf-name", "改名后的配置");
    setValue(".pf-model", "gpt-4.1");
    click(".pf-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers[0]?.name).toBe("改名后的配置");
    });

    const s = await getSettings();
    expect(s.providers[0].model).toBe("gpt-4.1");
    expect(s.providers[0].apiKey).toBe(p1.apiKey);
  });

  it("trims the typed API key on save", async () => {
    await seed();
    await boot();

    click(".provider-add");
    setValue(".pf-name", "Trimmed");
    setValue(".pf-baseURL", "https://trim.test");
    setValue(".pf-apiKey", "  key-123456  ");
    setValue(".pf-model", "trim-model");
    click(".pf-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(1);
    });
    expect((await getSettings()).providers[0].apiKey).toBe("key-123456");
  });

  it("round-trips the 自动补 /v1 checkbox opt-out", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    click(".provider-edit");
    const checkbox = document.querySelector(".pf-appendV1") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    checkbox.checked = false;
    click(".pf-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers[0]?.appendV1).toBe(false);
    });

    click(".provider-edit");
    expect((document.querySelector(".pf-appendV1") as HTMLInputElement).checked).toBe(false);
  });

  it("copies a provider with a new id and a 副本 name", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    click(".provider-copy");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(2);
    });

    const s = await getSettings();
    const copy = s.providers.find((p) => p.id !== p1.id);
    expect(copy).toBeTruthy();
    expect(copy?.name).toContain("副本");
    expect(copy?.baseURL).toBe(p1.baseURL);
    expect(copy?.apiKey).toBe(p1.apiKey);
  });

  it("deletes a provider after confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await seed({ providers: [p1, p2], activeProviderId: p2.id });
    await boot();

    const card = document.querySelector(`[data-provider-id="${p1.id}"]`) as HTMLElement;
    click(".provider-delete", card);

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers.map((p) => p.id)).toEqual([p2.id]);
    });
    expect(confirm).toHaveBeenCalledWith("确认删除该配置？");
  });
});

describe("provider form actions", () => {
  it("shows the fetch failure note and still saves a manually entered model", async () => {
    await seed();
    const providers = await boot();
    providers.listModels.mockRejectedValue(new Error("boom"));

    click(".provider-add");
    setValue(".pf-name", "手填配置");
    setValue(".pf-baseURL", "https://manual.test");
    setValue(".pf-apiKey", "manual-key-1234");
    setValue(".pf-model", "manual-model");
    click(".pf-fetch-models");

    await vi.waitFor(() => {
      expect(document.querySelector(".pf-models-status")?.textContent).toBe(
        "拉取失败，可直接手填",
      );
    });
    expect(
      document.querySelector(".pf-models-status")?.classList.contains("error"),
    ).toBe(true);

    click(".pf-save");
    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(1);
    });
    expect((await getSettings()).providers[0].model).toBe("manual-model");
  });

  it("reports a successful connection with latency", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    const providers = await boot();
    providers.complete.mockResolvedValue({ text: "ok" });

    click(".provider-test");

    await vi.waitFor(() => {
      expect(document.querySelector(".provider-test-result")?.textContent).toMatch(
        /^连接成功（\d+ ms）$/,
      );
    });
    expect(
      document.querySelector(".provider-test-result")?.classList.contains("success"),
    ).toBe(true);
    expect(providers.complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: p1.id }),
      expect.objectContaining({ maxTokens: 1 }),
    );
  });

  it("shows a classified connection error without leaking the key", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    const providers = await boot();
    providers.complete.mockRejectedValue(
      new ProviderError("auth", `bad key ${p1.apiKey}`),
    );

    click(".provider-test");

    await vi.waitFor(() => {
      expect(
        document.querySelector(".provider-test-result")?.classList.contains("error"),
      ).toBe(true);
    });

    const text = document.querySelector(".provider-test-result")?.textContent ?? "";
    expect(text).toContain("认证失败");
    expect(text).not.toContain(p1.apiKey);
    expect(text).not.toContain("sk-");
  });
});

describe("global settings", () => {
  it("preserves promptVersion when the prompt is unchanged and recomputes it after an edit", async () => {
    await seed({
      providers: [p1],
      activeProviderId: p1.id,
      systemPrompt: "旧提示词",
      promptVersion: "keep-me",
      concurrency: 2,
      maxRPS: 5,
    });
    await boot();

    setValue(".global-concurrency", "99");
    setValue(".global-maxRPS", "30");
    click(".global-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.concurrency).toBe(10);
    });

    let s = await getSettings();
    expect(s.maxRPS).toBe(20);
    expect(s.promptVersion).toBe("keep-me");

    setValue(".global-systemPrompt", "新提示词");
    click(".global-save");

    await vi.waitFor(async () => {
      const updated = await getSettings();
      expect(updated.promptVersion).toBe(await promptVersionFor("新提示词"));
    });

    s = await getSettings();
    expect(s.systemPrompt).toBe("新提示词");
  });

  it("initializes an empty stored promptVersion from the effective global prompt", async () => {
    await seed({ promptVersion: "", systemPrompt: "" });
    await boot();

    click(".global-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.promptVersion).toBe(await promptVersionFor(DEFAULT_SETTINGS.systemPrompt));
    });
  });

  it("keeps stored numeric values when the global fields are blank", async () => {
    await seed({ concurrency: 2, maxRPS: 5, temperature: 0.7 });
    await boot();

    setValue(".global-concurrency", "");
    setValue(".global-maxRPS", "");
    setValue(".global-temperature", "");
    click(".global-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.concurrency).toBe(2);
    });

    const s = await getSettings();
    expect(s.maxRPS).toBe(5);
    expect(s.temperature).toBe(0.7);
  });

  it("clears the translation cache after confirmation", async () => {
    const cache = new TranslationCache("ilmt");
    const key = await buildCacheKey({
      sourceText: "hello",
      targetLang: "zh-CN",
      providerConfigId: p1.id,
      modelId: p1.model,
      promptVersion: "v1",
    });
    await cache.put(key, "旧译文", { modelId: p1.model });
    expect(await cache.get(key)).toBe("旧译文");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    click(".global-clear-cache");

    await vi.waitFor(() => {
      expect(document.querySelector(".global-cache-message")?.textContent).toBe("已清空缓存");
    });
    expect(confirm).toHaveBeenCalledWith("确认清空翻译缓存？");
    expect(await cache.get(key)).toBeUndefined();
  });

  it("saves the selected active provider radio", async () => {
    await seed({ providers: [p1, p2], activeProviderId: p1.id });
    await boot();

    const radio = document.querySelector(
      'input[name="active-provider"][value="p2"]',
    ) as HTMLInputElement;
    radio.checked = true;
    click(".global-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.activeProviderId).toBe(p2.id);
    });
  });

  it("migrates a stored triggerMode of auto to auto-current-site", async () => {
    await chrome.storage.local.set({
      settings: { ...settingsWith({}), triggerMode: "auto" },
    });

    expect((await getSettings()).triggerMode).toBe("auto-current-site");

    await boot();
    const checked = document.querySelector(
      'input[name="trigger-mode"]:checked',
    ) as HTMLInputElement;
    expect(checked.value).toBe("auto-current-site");
  });
});
