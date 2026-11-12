/**
 * DOM tests for the toolbar popup shell (`src/popup/main.ts`). The detailed
 * settings behavior lives in `settings-dom.test.ts`; this file covers the
 * shell, accordion defaults, page-mode fallback, and side-panel behavior.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, Settings } from "../../src/shared/types";
import { DEFAULT_SETTINGS } from "../../src/shared/storage";

vi.mock("../../src/providers", () => ({
  listModels: vi.fn(),
  complete: vi.fn(),
}));

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
  const tabsCreate = vi.fn(async () => undefined);
  const chrome = (globalThis as any).chrome;
  chrome.sidePanel = { open: sidePanelOpen };
  chrome.windows = { WINDOW_ID_CURRENT: -2 };
  chrome.tabs = { query: tabsQuery, create: tabsCreate };
  (globalThis as any).chrome = chrome;
  vi.spyOn(window, "close").mockImplementation(() => {});
  return { sidePanelOpen, tabsQuery, tabsCreate };
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
  window.history.replaceState({}, "", "/");
  await chrome.storage.local.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).__ilmtPopup;
  delete document.documentElement.dataset.theme;
  document.body.classList.remove("page-mode");
  document.querySelectorAll("style[data-ilmt-popup]").forEach((el) => el.remove());
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

async function boot(): Promise<void> {
  await import("../../src/popup/main");
  await (globalThis as any).__ilmtPopup.ready;
}

describe("popup shell", () => {
  it("renders five settings sections and defaults to model settings", async () => {
    installChrome();
    await seed();
    await boot();

    expect(document.documentElement.dataset.theme).toBe("quantum");
    expect(document.querySelector(".popup-title")?.textContent).toBe("翻译设置");
    expect(document.querySelector(".popup-open-options")).toBeNull();
    expect(document.querySelectorAll("details.settings-section")).toHaveLength(5);
    expect(
      Array.from(document.querySelectorAll("details.settings-section")).map((node) =>
        (node as HTMLElement).dataset.section,
      ),
    ).toEqual(["model", "translation", "learning", "advanced", "maintenance"]);
    expect(
      (document.querySelector('details[data-section="model"]') as HTMLDetailsElement).open,
    ).toBe(true);
    expect(document.querySelector(".settings-empty, .settings-model-summary")).not.toBeNull();
    expect(document.querySelector(".popup-open-sidepanel")).not.toBeNull();
  });

  it("keeps every section body mounted while switching the accordion", async () => {
    installChrome();
    await seed({ providers: [p1], activeProviderId: p1.id });
    await boot();

    const model = document.querySelector('details[data-section="model"]') as HTMLDetailsElement;
    const translation = document.querySelector(
      'details[data-section="translation"]',
    ) as HTMLDetailsElement;
    translation.open = true;
    translation.dispatchEvent(new Event("toggle"));

    expect(model.open).toBe(false);
    expect(translation.open).toBe(true);
    expect(document.querySelector(".global-minParagraphLength")).not.toBeNull();
    expect(document.querySelector(".global-concurrency")).not.toBeNull();
  });

  it("opens the side panel in the current window and closes the popup", async () => {
    const { sidePanelOpen } = installChrome();
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

  it("uses page mode for popup.html?mode=page without closing the tab", async () => {
    const { sidePanelOpen } = installChrome();
    window.history.replaceState({}, "", "/?mode=page");
    await boot();

    expect(document.body.classList.contains("page-mode")).toBe(true);
    (document.querySelector(".popup-open-sidepanel") as HTMLButtonElement).click();
    await flush();

    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: -2 });
    expect(window.close).not.toHaveBeenCalled();
  });
});
