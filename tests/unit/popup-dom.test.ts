/**
 * DOM tests for the toolbar popup UI (`src/popup/main.ts`). `main.ts` is
 * side-effectful (it reads settings and renders on load), so each test
 * installs a fresh `chrome` surface, re-imports the module, and waits for the
 * exposed `__ilmtPopup.ready` promise.
 *
 * Opening the popup must never issue a network request: `listModels` and
 * `complete` are mocked and only fire after the user clicks 拉取模型 / 测试连接.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ProviderConfig, Settings } from "../../src/shared/types";
import { DEFAULT_SETTINGS, getSettings } from "../../src/shared/storage";
import { ProviderError } from "../../src/shared/errors";
import { DEEPSEEK_PRESET } from "../../src/shared/providers";

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
  name: "自定义配置一",
  kind: "custom",
  baseURL: "https://api.one.test/v1",
  apiKey: "key-one",
  model: "model-one",
  appendV1: false,
  createdAt: 1,
};

const p2: ProviderConfig = {
  id: "p2",
  name: "自定义配置二",
  kind: "custom",
  baseURL: "https://api.two.test/v1",
  apiKey: "key-two",
  model: "model-two",
  createdAt: 2,
};

function settingsWith(partial: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providers: [],
    siteRules: {},
    ...partial,
  };
}

async function seed(partial: Partial<Settings> = {}): Promise<void> {
  await chrome.storage.local.set({ settings: settingsWith(partial) });
}

function installChrome() {
  const sidePanelOpen = vi.fn(async () => undefined);
  const tabsQuery = vi.fn(async (): Promise<Array<{ id?: number }>> => []);
  const openOptionsPage = vi.fn(async () => undefined);
  const tabsCreate = vi.fn(async () => undefined);

  const chrome = (globalThis as any).chrome;
  chrome.runtime = {
    ...chrome.runtime,
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    openOptionsPage,
  };
  chrome.sidePanel = { open: sidePanelOpen };
  chrome.windows = { WINDOW_ID_CURRENT: -2 };
  chrome.tabs = { query: tabsQuery, create: tabsCreate };
  (globalThis as any).chrome = chrome;

  vi.spyOn(window, "close").mockImplementation(() => {});

  return { sidePanelOpen, tabsQuery, openOptionsPage, tabsCreate };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = `<div id="root"></div>`;
  delete (globalThis as any).__ilmtPopup;
  await chrome.storage.local.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).__ilmtPopup;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll("style[data-ilmt-popup]").forEach((el) => el.remove());
  document.body.innerHTML = "";
});

async function boot(): Promise<ProvidersMock> {
  const providers = (await import("../../src/providers")) as unknown as ProvidersMock;
  await import("../../src/popup/main");
  await (globalThis as any).__ilmtPopup.ready;
  return providers;
}

function setValue(selector: string, value: string, root: ParentNode = document): void {
  const node = root.querySelector(selector) as HTMLInputElement | null;
  if (!node) throw new Error(`missing ${selector}`);
  node.value = value;
}

function click(selector: string, root: ParentNode = document): void {
  const node = root.querySelector(selector) as HTMLElement | null;
  if (!node) throw new Error(`missing ${selector}`);
  node.click();
}

describe("popup model configuration", () => {
  it("opens with the DeepSeek form when there are no providers", async () => {
    installChrome();
    await seed();
    await boot();

    expect((document.querySelector(".popup-kind") as HTMLSelectElement).value).toBe("deepseek");
    expect((document.querySelector(".popup-model") as HTMLInputElement).value).toBe(
      "deepseek-flash",
    );
    expect(document.querySelector(".popup-name")).toBeNull();
    expect(document.querySelector(".popup-baseURL")).toBeNull();
    expect(document.querySelector(".popup-appendV1")).toBeNull();
    expect(document.querySelector(".popup-apiKey")).not.toBeNull();
    expect(document.documentElement.dataset.theme).toBe("quantum");
  });

  it("shows custom fields after choosing the custom type", async () => {
    installChrome();
    await seed();
    await boot();

    const kind = document.querySelector(".popup-kind") as HTMLSelectElement;
    kind.value = "custom";
    kind.dispatchEvent(new Event("change"));

    expect(document.querySelector(".popup-name")).not.toBeNull();
    expect(document.querySelector(".popup-baseURL")).not.toBeNull();
    expect(document.querySelector(".popup-appendV1")).not.toBeNull();
    expect((document.querySelector(".popup-baseURL") as HTMLInputElement).value).toBe(
      "https://api.openai.com",
    );
    expect((document.querySelector(".popup-appendV1") as HTMLInputElement).checked).toBe(true);
  });

  it("preserves typed API key and model when switching type in a new provider", async () => {
    installChrome();
    await seed();
    await boot();

    setValue(".popup-apiKey", "sk-ds-1234");
    setValue(".popup-model", "my-custom-model");

    let kind = document.querySelector(".popup-kind") as HTMLSelectElement;
    kind.value = "custom";
    kind.dispatchEvent(new Event("change"));

    expect((document.querySelector(".popup-apiKey") as HTMLInputElement).value).toBe(
      "sk-ds-1234",
    );
    expect((document.querySelector(".popup-model") as HTMLInputElement).value).toBe(
      "my-custom-model",
    );

    kind = document.querySelector(".popup-kind") as HTMLSelectElement;
    kind.value = "deepseek";
    kind.dispatchEvent(new Event("change"));

    expect((document.querySelector(".popup-apiKey") as HTMLInputElement).value).toBe(
      "sk-ds-1234",
    );
    expect((document.querySelector(".popup-model") as HTMLInputElement).value).toBe(
      "my-custom-model",
    );

    click(".popup-save");
    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(1);
    });

    const saved = (await getSettings()).providers[0];
    expect(saved).toMatchObject({
      kind: "deepseek",
      apiKey: "sk-ds-1234",
      model: "my-custom-model",
    });
  });

  it("saves a DeepSeek provider with the preset and makes it active", async () => {
    installChrome();
    await seed();
    await boot();

    setValue(".popup-apiKey", "sk-ds-1234");
    setValue(".popup-model", "deepseek-v4-pro");
    click(".popup-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(1);
    });

    const s = await getSettings();
    expect(s.providers[0]).toMatchObject({
      kind: "deepseek",
      name: "DeepSeek",
      baseURL: DEEPSEEK_PRESET.baseURL,
      appendV1: false,
      apiKey: "sk-ds-1234",
      model: "deepseek-v4-pro",
    });
    expect(s.activeProviderId).toBe(s.providers[0].id);
    expect(document.querySelector(".popup-save-status")?.textContent).toBe("已保存");
  });

  it("loads an existing provider, masks the key, and preserves hidden fields", async () => {
    installChrome();
    const provider: ProviderConfig = {
      id: "c1",
      name: "自定义配置",
      kind: "custom",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-old-1234",
      model: "m1",
      appendV1: false,
      extraHeaders: { "X-Token": "{{apiKey}}" },
      overrides: { concurrency: 2 },
      createdAt: 1,
    };
    await seed({ providers: [provider], activeProviderId: provider.id });
    await boot();

    const keyInput = document.querySelector(".popup-apiKey") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(keyInput.placeholder).toContain("已保存（");
    expect(keyInput.placeholder).toContain("****");
    expect(keyInput.placeholder).not.toContain(provider.apiKey);

    setValue(".popup-model", "m2");
    click(".popup-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers[0]?.model).toBe("m2");
    });

    const saved = (await getSettings()).providers[0];
    expect(saved.kind).toBe("custom");
    expect(saved.apiKey).toBe("sk-old-1234");
    expect(saved.baseURL).toBe("https://api.example.com/v1");
    expect(saved.extraHeaders).toEqual({ "X-Token": "{{apiKey}}" });
    expect(saved.overrides).toEqual({ concurrency: 2 });
    expect(saved.model).toBe("m2");
  });

  it("shows a placeholder option and clears the provider select in new mode", async () => {
    installChrome();
    await seed({ providers: [p1, p2], activeProviderId: p1.id });
    await boot();

    click(".popup-add");

    const select = document.querySelector(".popup-provider-select") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.querySelector('option[value=""]')?.textContent).toBe("新增配置…");
    expect(document.querySelector(".popup-kind")).not.toBeNull();

    select.value = p2.id;
    select.dispatchEvent(new Event("change"));
    expect(document.querySelector(".popup-kind")).toBeNull();
    expect(select.value).toBe(p2.id);
  });

  it("edits an existing DeepSeek provider without exposing or replacing the key", async () => {
    installChrome();
    const provider: ProviderConfig = {
      id: "ds1",
      name: "DeepSeek",
      kind: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: "ds-key-abc123",
      appendV1: false,
      model: "deepseek-flash",
      createdAt: 1,
    };
    await seed({ providers: [provider], activeProviderId: provider.id });
    await boot();

    expect(document.querySelector(".popup-baseURL")).toBeNull();
    expect(document.querySelector(".popup-name")).toBeNull();

    setValue(".popup-model", "deepseek-v4-pro");
    click(".popup-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers[0]?.model).toBe("deepseek-v4-pro");
    });

    const saved = (await getSettings()).providers[0];
    expect(saved.kind).toBe("deepseek");
    expect(saved.baseURL).toBe("https://api.deepseek.com");
    expect(saved.appendV1).toBe(false);
    expect(saved.apiKey).toBe("ds-key-abc123");
    expect(saved.name).toBe("DeepSeek");
  });

  it("fetches models on demand and fills the datalist", async () => {
    installChrome();
    await seed();
    const providers = await boot();
    providers.listModels.mockResolvedValue([
      { id: "deepseek-flash" },
      { id: "deepseek-v4-pro" },
      { id: "deepseek-extra" },
    ]);

    click(".popup-fetch-models");

    await vi.waitFor(() => {
      expect(document.querySelector(".popup-models-status")?.textContent).toBe(
        "已获取 3 个模型",
      );
    });

    const values = Array.from(
      document.querySelectorAll<HTMLOptionElement>(".popup-model-options option"),
    ).map((option) => option.value);
    expect(values).toContain("deepseek-extra");
  });

  it("keeps the DeepSeek fallback and allows manual save when fetching fails", async () => {
    installChrome();
    await seed();
    const providers = await boot();
    providers.listModels.mockRejectedValue(new Error("boom"));

    click(".popup-fetch-models");

    await vi.waitFor(() => {
      expect(document.querySelector(".popup-models-status")?.textContent).toBe(
        "拉取失败，可直接手填",
      );
    });

    const values = Array.from(
      document.querySelectorAll<HTMLOptionElement>(".popup-model-options option"),
    ).map((option) => option.value);
    expect(values).toContain("deepseek-flash");
    expect(values).toContain("deepseek-v4-pro");

    setValue(".popup-apiKey", "manual-key");
    setValue(".popup-model", "manual-model");
    click(".popup-save");

    await vi.waitFor(async () => {
      const s = await getSettings();
      expect(s.providers).toHaveLength(1);
    });
    expect((await getSettings()).providers[0].model).toBe("manual-model");
  });

  it("tests the connection without leaking the key", async () => {
    installChrome();
    await seed();
    const providers = await boot();

    providers.complete.mockResolvedValue({ text: "ok" });
    setValue(".popup-apiKey", "sk-ds-1234");
    click(".popup-test");

    await vi.waitFor(() => {
      expect(document.querySelector(".popup-test-result")?.textContent).toMatch(
        /^连接成功（\d+ ms）$/,
      );
    });
    expect(document.body.textContent).not.toContain("sk-ds-1234");

    providers.complete.mockRejectedValue(new ProviderError("auth", "bad sk-ds-1234"));
    click(".popup-test");

    await vi.waitFor(() => {
      expect(document.querySelector(".popup-test-result")?.textContent).toBe("连接失败：认证失败");
    });
    expect(document.body.textContent).not.toContain("sk-ds-1234");
  });

  it("sets a non-active provider as current", async () => {
    installChrome();
    await seed({ providers: [p1, p2], activeProviderId: p1.id });
    await boot();

    const select = document.querySelector(".popup-provider-select") as HTMLSelectElement;
    select.value = p2.id;
    select.dispatchEvent(new Event("change"));
    click(".popup-set-active");

    await flush();
    expect((await getSettings()).activeProviderId).toBe(p2.id);
  });

  it("activates the quantum teal theme", async () => {
    installChrome();
    await seed();
    await boot();
    expect(document.documentElement.dataset.theme).toBe("quantum");
  });

  it("opens the side panel in the current window and closes the popup", async () => {
    const { sidePanelOpen } = installChrome();
    sidePanelOpen.mockResolvedValue(undefined);
    await boot();

    (document.querySelector(".popup-open-sidepanel") as HTMLButtonElement).click();
    await flush();

    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: -2 });
    expect(window.close).toHaveBeenCalled();
  });

  it("falls back to the active tab when opening the side panel by window fails", async () => {
    const { sidePanelOpen, tabsQuery } = installChrome();
    sidePanelOpen
      .mockRejectedValueOnce(new Error("no window"))
      .mockResolvedValueOnce(undefined);
    tabsQuery.mockResolvedValue([{ id: 7 }]);
    await boot();

    (document.querySelector(".popup-open-sidepanel") as HTMLButtonElement).click();
    await flush();

    expect(sidePanelOpen).toHaveBeenNthCalledWith(1, { windowId: -2 });
    expect(sidePanelOpen).toHaveBeenNthCalledWith(2, { tabId: 7 });
    expect(window.close).toHaveBeenCalled();
  });

  it("keeps the popup open when the side-panel fallback query fails", async () => {
    const { sidePanelOpen, tabsQuery } = installChrome();
    sidePanelOpen.mockRejectedValueOnce(new Error("no window"));
    tabsQuery.mockRejectedValueOnce(new Error("query failed"));
    await boot();

    (document.querySelector(".popup-open-sidepanel") as HTMLButtonElement).click();
    await flush();

    expect(window.close).not.toHaveBeenCalled();
  });

  it("opens the options page and falls back to a tab", async () => {
    const { openOptionsPage, tabsCreate } = installChrome();
    openOptionsPage.mockResolvedValue(undefined);
    await boot();

    (document.querySelector(".popup-open-options") as HTMLButtonElement).click();
    await flush();
    expect(openOptionsPage).toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();

    openOptionsPage.mockRejectedValue(new Error("no options page"));
    (document.querySelector(".popup-open-options") as HTMLButtonElement).click();
    await flush();
    expect(tabsCreate).toHaveBeenCalledWith({
      url: "chrome-extension://test-extension-id/options.html",
    });
  });
});
