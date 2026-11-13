import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ProviderConfig, Settings } from "../../src/shared/types";
import { DEFAULT_SETTINGS, getSettings } from "../../src/shared/storage";
import { ProviderError } from "../../src/shared/errors";
import { buildCacheKey, TranslationCache } from "../../src/background/cache";

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

const deepseek: ProviderConfig = {
  id: "ds",
  name: "DeepSeek",
  kind: "deepseek",
  baseURL: "https://api.deepseek.com",
  apiKey: "sk-deepseek-1234",
  appendV1: false,
  model: "deepseek-flash",
  createdAt: 3,
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
  await import("../../src/popup/main");
  await (globalThis as unknown as { __ilmtPopup: { ready: Promise<void> } }).__ilmtPopup.ready;
  const manage = document.querySelector(".settings-manage-models") as HTMLElement | null;
  manage?.click();
  return providers;
}

/**
 * Ids from the registry the popup just booted. `vi.resetModules()` re-instantiates
 * `src/content/effects` per test, so the lookup has to be dynamic — a top-level
 * import would resolve the discarded pre-reset instance and always be empty.
 */
async function effectIds(): Promise<string[]> {
  const { getEffects } = await import("../../src/content/effects");
  return getEffects().map((effect) => effect.id);
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

function setKind(value: "custom" | "deepseek"): void {
  const kind = document.querySelector(".pf-kind") as HTMLSelectElement | null;
  if (!kind) throw new Error("missing .pf-kind");
  kind.value = value;
  kind.dispatchEvent(new Event("change"));
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = `<div id="root"></div>`;
  delete (globalThis as unknown as { __ilmtPopup?: unknown }).__ilmtPopup;
  await chrome.storage.local.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.querySelectorAll("style[data-ilmt-popup]").forEach((el) => el.remove());
  document.querySelectorAll("style[data-ilmt-effects]").forEach((el) => el.remove());
  delete (globalThis as unknown as { __ilmtPopup?: unknown }).__ilmtPopup;
  delete document.documentElement.dataset.theme;
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
    setKind("custom");
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
    setKind("custom");
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

  it("deletes a provider after two-step confirmation", async () => {
    await seed({ providers: [p1, p2], activeProviderId: p2.id });
    await boot();

    const card = document.querySelector(`[data-provider-id="${p1.id}"]`) as HTMLElement;
    click(".provider-delete", card);
    expect((await getSettings()).providers.map((p) => p.id)).toEqual([p1.id, p2.id]);
    click(".provider-delete", card);

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers.map((p) => p.id)).toEqual([p2.id]);
    });
  });
});

describe("provider kind", () => {
  it("defaults a new provider to DeepSeek", async () => {
    await seed();
    await boot();
    click(".provider-add");
    expect((document.querySelector(".pf-kind") as HTMLSelectElement).value).toBe("deepseek");
    expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector(".pf-model") as HTMLInputElement).value).toBe(
      "deepseek-flash",
    );
  });

  it("edits a DeepSeek provider with the type and preset locked", async () => {
    await seed({ providers: [deepseek], activeProviderId: deepseek.id });
    await boot();

    click(".provider-edit");
    expect(document.querySelector(".pf-kind")).toBeNull();
    expect(document.querySelector(".pf-kind-readonly")?.textContent).toBe("DeepSeek");
    expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector(".pf-name-field") as HTMLElement).hidden).toBe(true);

    setValue(".pf-model", "deepseek-v4-pro");
    click(".pf-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers[0]?.model).toBe("deepseek-v4-pro");
    });

    const saved = (await getSettings()).providers[0];
    expect(saved).toMatchObject({
      kind: "deepseek",
      baseURL: "https://api.deepseek.com",
      appendV1: false,
      name: "DeepSeek",
      apiKey: "sk-deepseek-1234",
    });
  });

  it("creates a DeepSeek provider from the type selector", async () => {
    await seed();
    await boot();

    click(".provider-add");
    const kind = document.querySelector(".pf-kind") as HTMLSelectElement;
    kind.value = "deepseek";
    kind.dispatchEvent(new Event("change"));

    expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector(".pf-name-field") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector(".pf-appendV1-row") as HTMLElement).hidden).toBe(true);

    setValue(".pf-apiKey", "sk-new-1234");
    setValue(".pf-model", "deepseek-flash");
    click(".pf-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(1);
    });

    const saved = (await getSettings()).providers[0];
    expect(saved).toMatchObject({
      kind: "deepseek",
      name: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      appendV1: false,
      apiKey: "sk-new-1234",
      model: "deepseek-flash",
    });
  });

  it("reveals custom fields when switching back from DeepSeek", async () => {
    await seed();
    await boot();
    click(".provider-add");

    const kind = document.querySelector(".pf-kind") as HTMLSelectElement;
    kind.value = "deepseek";
    kind.dispatchEvent(new Event("change"));
    kind.value = "custom";
    kind.dispatchEvent(new Event("change"));

    expect((document.querySelector(".pf-baseURL-field") as HTMLElement).hidden).toBe(false);
    expect((document.querySelector(".pf-name-field") as HTMLElement).hidden).toBe(false);
    expect((document.querySelector(".pf-baseURL") as HTMLInputElement).value).toBe("https://api.openai.com");
    expect((document.querySelector(".pf-appendV1") as HTMLInputElement).checked).toBe(true);
  });
});

describe("provider form actions", () => {
  it("shows the fetch failure note and still saves a manually entered model", async () => {
    await seed();
    const providers = await boot();
    providers.listModels.mockRejectedValue(new Error("boom"));

    click(".provider-add");
    setKind("custom");
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
  it("preserves the stored prompt version while saving advanced settings", async () => {
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
    click(".advanced-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.concurrency).toBe(10);
    });

    const s = await getSettings();
    expect(s.maxRPS).toBe(20);
    expect(s.promptVersion).toBe("keep-me");
    expect(s.systemPrompt).toBe("旧提示词");
  });

  it("renders the glossary toggle and saves false without rewriting the prompt version", async () => {
    await seed({
      glossaryEnabled: true,
      systemPrompt: "旧提示词",
      promptVersion: "keep-me",
    });
    await boot();

    const checkbox = document.querySelector<HTMLInputElement>(".global-glossaryEnabled")!;
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    click(".translation-save");

    await vi.waitFor(async () => {
      expect((await getSettings()).glossaryEnabled).toBe(false);
    });

    const s = await getSettings();
    expect(s.promptVersion).toBe("keep-me");
  });

  it("saves the glossary toggle when it turns on", async () => {
    await seed({
      glossaryEnabled: false,
      systemPrompt: "旧提示词",
      promptVersion: "keep-me",
    });
    await boot();

    const checkbox = document.querySelector<HTMLInputElement>(".global-glossaryEnabled")!;
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true;
    click(".translation-save");

    await vi.waitFor(async () => {
      expect((await getSettings()).glossaryEnabled).toBe(true);
    });

    const s = await getSettings();
    expect(s.promptVersion).toBe("keep-me");
  });

  it("keeps stored numeric values when the global fields are blank", async () => {
    await seed({ concurrency: 2, maxRPS: 5, temperature: 0.7 });
    await boot();

    setValue(".global-concurrency", "");
    setValue(".global-maxRPS", "");
    setValue(".global-temperature", "");
    click(".advanced-save");

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
    await cache.put(key, { text: "旧译文", glossary: [] }, { modelId: p1.model });
    expect(await cache.get(key)).toEqual({ text: "旧译文", glossary: [] });

    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    click(".global-clear-cache");
    expect(await cache.get(key)).toEqual({ text: "旧译文", glossary: [] });
    click(".global-clear-cache");

    await vi.waitFor(() => {
      expect(document.querySelector(".global-cache-message")?.textContent).toBe("已清空缓存");
    });
    expect(await cache.get(key)).toBeUndefined();
  });

  it("saves the selected active provider from the model select", async () => {
    await seed({ providers: [p1, p2], activeProviderId: p1.id });
    await boot();

    const select = document.querySelector(".settings-active-provider") as HTMLSelectElement;
    select.value = p2.id;
    select.dispatchEvent(new Event("change"));

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

  it("renders and saves granularity settings", async () => {
    await seed();
    await boot();

    const minLength = document.querySelector(".global-minParagraphLength") as HTMLInputElement;
    const contentOnly = document.querySelector(".global-contentOnly") as HTMLInputElement;
    expect(minLength.value).toBe("10");
    expect(contentOnly.checked).toBe(true);

    setValue(".global-minParagraphLength", "50");
    contentOnly.checked = false;
    click(".translation-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.minParagraphLength).toBe(50);
    });

    const s = await getSettings();
    expect(s.contentOnly).toBe(false);
  });

  it("clamps out-of-range minimum length on save", async () => {
    await seed();
    await boot();

    setValue(".global-minParagraphLength", "2");
    click(".translation-save");

    await vi.waitFor(async () => {
      expect((await getSettings()).minParagraphLength).toBe(4);
    });
  });
});

it("activates the quantum teal theme", async () => {
  await seed();
  await boot();
  expect(document.documentElement.dataset.theme).toBe("quantum");
});

describe("model manager navigation", () => {
  it("shows the unselected state when activeProviderId is empty", async () => {
    await seed({ providers: [p1, p2], activeProviderId: "" });
    await boot();

    const select = document.querySelector(".settings-active-provider") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.options[0].textContent).toBe("请选择模型");
    expect(document.querySelector(".settings-model-summary")?.textContent).toContain(
      "未选择当前模型",
    );
    expect((document.querySelector(".settings-model-test") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("returns from the model manager to the settings home", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    expect((document.querySelector(".settings-home") as HTMLElement).hidden).toBe(true);
    click(".settings-back");
    expect((document.querySelector(".settings-home") as HTMLElement).hidden).toBe(false);
    expect((document.querySelector(".settings-subview-host") as HTMLElement).hidden).toBe(true);
  });

  it("guards a dirty provider form before leaving the manager", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();
    click(".provider-edit");

    const model = document.querySelector(".pf-model") as HTMLInputElement;
    model.value = "dirty-model";
    model.dispatchEvent(new Event("input", { bubbles: true }));

    click(".settings-back");
    expect(document.querySelector(".pf-discard")).not.toBeNull();
    click(".pf-discard-no");
    expect(document.querySelector(".pf-discard")).toBeNull();
    expect((document.querySelector(".settings-subview-host") as HTMLElement).hidden).toBe(false);

    click(".settings-back");
    click(".pf-discard-yes");
    expect((document.querySelector(".settings-home") as HTMLElement).hidden).toBe(false);
  });

  it("does not request models or a completion when the manager opens", async () => {
    await seed({ providers: [p1], activeProviderId: p1.id });
    const providers = await boot();

    expect(providers.listModels).not.toHaveBeenCalled();
    expect(providers.complete).not.toHaveBeenCalled();
  });
});

describe("translation style and learning settings", () => {
  it("saves a translation style and instructions", async () => {
    await seed();
    await boot();

    setValue(".global-preference-domain", "tech");
    setValue(".global-preference-instructions", "保留英文术语");
    click(".translation-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.preference).toEqual({ domain: "tech", instructions: "保留英文术语" });
    });
  });

  it("toggles learning languages within the whitelist", async () => {
    await seed();
    await boot();

    const en = document.querySelector<HTMLInputElement>('.global-learningLang[value="en"]')!;
    const es = document.querySelector<HTMLInputElement>('.global-learningLang[value="es"]')!;
    const ja = document.querySelector<HTMLInputElement>('.global-learningLang[value="ja"]')!;
    en.checked = false;
    es.checked = true;
    ja.checked = true;
    click(".learning-save");

    await vi.waitFor(async () => {
      expect((await getSettings()).learningLangs).toEqual(["ja", "es"]);
    });
  });

  it("renders the learning section with effect selection", async () => {
    await seed();
    await boot();
    const ids = await effectIds();

    expect(document.querySelectorAll(".global-effect-enabled")).toHaveLength(ids.length);
    expect(document.querySelector<HTMLInputElement>(".global-effect-enabled")!.checked).toBe(true);

    const mode = document.querySelector<HTMLSelectElement>(".global-mascot-mode")!;
    expect(Array.from(mode.options).map((option) => option.textContent)).toEqual([
      "随机轮换",
      "固定为",
    ]);
    expect(document.querySelector(".global-mascot-fixed")).toBeTruthy();
  });

  it("treats legacy stored effect ids as every effect enabled", async () => {
    await seed({
      mascot: { mode: "rotate", enabledIds: ["gopher"], animations: true },
    });
    await boot();

    const box = document.querySelector<HTMLInputElement>(
      '.global-effect-enabled[data-effect="gopher-hole"]',
    )!;
    expect(box.checked).toBe(true);
    expect(document.querySelectorAll(".global-mascot-fixed option")).toHaveLength(1);

    document.querySelector<HTMLButtonElement>(".learning-save")!.click();
    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.mascot.enabledIds).toEqual(["gopher-hole"]);
    });
  });

  it("mounts an effect preview without writing to the learning store", async () => {
    await seed();
    await boot();
    const button = document.querySelector<HTMLButtonElement>(".effect-try")!;
    button.click();
    const preview = document.querySelector<HTMLElement>(".effect-preview")!;
    expect(preview.hidden).toBe(false);
    const effectRoot = preview.querySelector<HTMLElement>('[data-ilmt-effect="gopher-hole"]');
    expect(effectRoot).toBeTruthy();

    const hit = effectRoot!.querySelector("button");
    expect(hit).toBeTruthy();
    hit!.click();

    await vi.waitFor(
      () => {
        expect(effectRoot!.dataset.ilmtState).toBe("settled");
      },
      { timeout: 3000 },
    );
    const stored = await chrome.storage.local.get("learning");
    expect(stored.learning).toBeUndefined();
  });

  it("saves the checked effects and the fixed choice", async () => {
    await seed();
    await boot();
    const ids = await effectIds();
    document.querySelector<HTMLSelectElement>(".global-mascot-mode")!.value = "fixed";
    document.querySelector<HTMLSelectElement>(".global-mascot-mode")!.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>(".learning-save")!.click();
    await vi.waitFor(async () => {
      const stored = await getSettings();
      expect(stored.mascot.mode).toBe("fixed");
      expect(stored.mascot.fixedId).toBe("gopher-hole");
      expect(stored.mascot.enabledIds).toEqual(ids);
    });
  });

  it("keeps at most one effect preview mounted and closes it on changes", async () => {
    await seed();
    await boot();
    const button = document.querySelector<HTMLButtonElement>(".effect-try")!;
    const slot = document.querySelector<HTMLElement>(".effect-preview")!;

    button.click();
    expect(slot.hidden).toBe(false);
    expect(slot.querySelectorAll('[data-ilmt-effect]')).toHaveLength(1);
    expect(document.querySelectorAll("style[data-ilmt-effects]")).toHaveLength(1);

    button.click();
    expect(slot.hidden).toBe(true);
    expect(slot.querySelectorAll('[data-ilmt-effect]')).toHaveLength(0);
    expect(document.querySelectorAll("style[data-ilmt-effects]")).toHaveLength(0);

    button.click();
    expect(slot.hidden).toBe(false);
    const mode = document.querySelector<HTMLSelectElement>(".global-mascot-mode")!;
    mode.value = "fixed";
    mode.dispatchEvent(new Event("change"));
    expect(slot.hidden).toBe(true);
    expect(slot.querySelectorAll('[data-ilmt-effect]')).toHaveLength(0);

    // 动效开关也会改变预览的播放方式，同样要收起
    button.click();
    expect(slot.hidden).toBe(false);
    const animations = document.querySelector<HTMLInputElement>(".global-mascot-animations")!;
    animations.checked = false;
    animations.dispatchEvent(new Event("change"));
    expect(slot.hidden).toBe(true);
    expect(slot.querySelectorAll('[data-ilmt-effect]')).toHaveLength(0);
  });

  it("refuses to save when no effect is checked", async () => {
    await seed();
    await boot();
    const box = document.querySelector<HTMLInputElement>(".global-effect-enabled")!;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>(".learning-save")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".learning-saved")?.textContent).toBe("至少启用一个特效");
    });
    const stored = await chrome.storage.local.get("settings");
    expect((stored.settings as Settings).mascot).toEqual(DEFAULT_SETTINGS.mascot);
  });

  it("removes the free-form global system prompt", async () => {
    await seed();
    await boot();
    expect(document.querySelector(".global-systemPrompt")).toBeNull();
  });
});

describe("pending review entry", () => {
  it("shows the due count and opens the side panel on click", async () => {
    const now = Date.now();
    const words = [1, 2, 3].map((i) => ({
      id: `en:word${i}`,
      termLang: "en",
      surface: `word${i}`,
      glosses: [{ lang: "zh", meaning: `词${i}`, source: "translation", at: now }],
      glossLang: "zh",
      contexts: [],
      status: "learning",
      box: 0,
      dueAt: now - 1000,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      reviews: [],
      reviewsCount: 0,
      correctCount: 0,
      checksSinceSpot: 0,
    }));
    await seed();
    await chrome.storage.local.set({
      learning: { version: 1, words, stats: { day: "", todayReviewed: 0 }, updatedAt: now },
    });
    const sessionSet = vi.fn(async () => {});
    const open = vi.fn(async () => {});
    (chrome as unknown as { storage: { session: unknown } }).storage.session = { set: sessionSet };
    (chrome as unknown as { sidePanel: unknown }).sidePanel = { open };

    await boot();

    const entry = document.querySelector(".popup-review-entry") as HTMLButtonElement | null;
    expect(entry).toBeTruthy();
    expect(entry?.textContent).toContain("待复习 3");

    entry!.click();

    await vi.waitFor(() => {
      expect(sessionSet).toHaveBeenCalledWith({ reviewPending: true });
    });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
