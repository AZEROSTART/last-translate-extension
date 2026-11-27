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
  const tabsQuery = vi.fn(async (): Promise<Array<{ id?: number; url?: string }>> => []);
  const tabsCreate = vi.fn(async () => undefined);
  const tabsSendMessage = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
  const commandsGetAll = vi.fn(async () => [
    { name: "translate-page", shortcut: "Alt+A" },
    { name: "ask-selection", shortcut: "Alt+Q" },
    { name: "toggle-side-panel", shortcut: "Alt+S" },
  ]);
  const chrome = (globalThis as any).chrome;
  chrome.sidePanel = { open: sidePanelOpen };
  chrome.windows = { WINDOW_ID_CURRENT: -2 };
  chrome.tabs = { query: tabsQuery, create: tabsCreate, sendMessage: tabsSendMessage };
  chrome.commands = { getAll: commandsGetAll };
  (globalThis as any).chrome = chrome;
  vi.spyOn(window, "close").mockImplementation(() => {});
  return { sidePanelOpen, tabsQuery, tabsCreate, tabsSendMessage, commandsGetAll };
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

  it("warns when the translate shortcut is unassigned", async () => {
    const { commandsGetAll } = installChrome();
    commandsGetAll.mockResolvedValue([
      { name: "translate-page", shortcut: "" },
      { name: "ask-selection", shortcut: "Alt+Q" },
      { name: "toggle-side-panel", shortcut: "Alt+S" },
    ]);
    await boot();
    await flush();

    expect(document.querySelector(".popup-host-warning")?.textContent).toContain("快捷键");
    expect(document.querySelector(".popup-host-warning")?.textContent).toContain(
      "chrome://extensions/shortcuts",
    );
  });

  it("warns when the active page has no content script", async () => {
    const { tabsQuery, tabsSendMessage } = installChrome();
    tabsQuery.mockResolvedValue([{ id: 7 }]);
    tabsSendMessage.mockRejectedValue(new Error("Could not establish connection"));
    await boot();
    await flush();

    expect(document.querySelector(".popup-host-warning")?.textContent).toContain("没有注入");
  });

  it("stays quiet when the shortcut is bound and the page has a content script", async () => {
    const { tabsQuery } = installChrome();
    tabsQuery.mockResolvedValue([{ id: 7 }]);
    await boot();
    await flush();

    expect(document.querySelector(".popup-host-warning")).toBeNull();
  });

  it("reveals the primary translate button and sends the activate message", async () => {
    const { tabsQuery, tabsSendMessage } = installChrome();
    tabsQuery.mockResolvedValue([{ id: 7, url: "https://example.test/article" }]);
    tabsSendMessage
      .mockResolvedValueOnce({ ok: true, active: false })
      .mockResolvedValueOnce(undefined);
    await boot();
    await flush();

    const button = document.querySelector<HTMLButtonElement>(".popup-translate-btn")!;
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.dataset.active).toBe("0");
    expect(button.textContent).toBe("翻译当前页");

    button.click();
    await flush();

    expect(tabsSendMessage).toHaveBeenLastCalledWith(7, { type: "activate" });
    expect(window.close).toHaveBeenCalled();
  });

  it("labels an active page as 还原当前页", async () => {
    const { tabsQuery, tabsSendMessage } = installChrome();
    tabsQuery.mockResolvedValue([{ id: 7, url: "https://example.test/article" }]);
    tabsSendMessage.mockResolvedValueOnce({ ok: true, active: true });
    await boot();
    await flush();

    const button = document.querySelector<HTMLButtonElement>(".popup-translate-btn")!;
    expect(button.hidden).toBe(false);
    expect(button.dataset.active).toBe("1");
    expect(button.textContent).toBe("还原当前页");
  });

  it("hides the translate button and warns when the probe fails", async () => {
    const { tabsQuery, tabsSendMessage } = installChrome();
    tabsQuery.mockResolvedValue([{ id: 7, url: "https://example.test/article" }]);
    tabsSendMessage.mockRejectedValue(new Error("Could not establish connection"));
    await boot();
    await flush();

    expect(document.querySelector<HTMLButtonElement>(".popup-translate-btn")!.hidden).toBe(true);
    expect(document.querySelector(".popup-host-warning")?.textContent).toContain("没有注入");
  });

  it("fills the hint from the real shortcut bindings", async () => {
    const { commandsGetAll } = installChrome();
    commandsGetAll.mockResolvedValue([
      { name: "translate-page", shortcut: "⌥A" },
      { name: "ask-selection", shortcut: "⌥Q" },
      { name: "toggle-side-panel", shortcut: "⌥S" },
    ]);
    await boot();
    await flush();

    expect(document.querySelector(".popup-hint")?.textContent).toBe("⌥A 翻译 · ⌥Q 解释 · ⌥S 侧栏");
  });

  it("falls back per command when a binding or the API is missing", async () => {
    const { commandsGetAll } = installChrome();
    commandsGetAll.mockResolvedValue([{ name: "ask-selection", shortcut: "Ctrl+Q" }]);
    await boot();
    await flush();

    expect(document.querySelector(".popup-hint")?.textContent).toBe(
      "Alt+A 翻译 · Ctrl+Q 解释 · Alt+S 侧栏",
    );
  });

  it("passes an http host to the site-rules UI and omits non-web hosts", async () => {
    const web = installChrome();
    web.tabsQuery.mockResolvedValue([{ id: 7, url: "https://news.example.test/a" }]);
    await boot();
    await flush();
    expect(document.querySelector(".site-rule-host")?.textContent).toBe("news.example.test");
    expect(document.body.textContent).toContain("当前站点");

    vi.resetModules();
    document.body.innerHTML = `<div id="root"></div>`;
    delete (globalThis as any).__ilmtPopup;
    web.tabsQuery.mockResolvedValue([{ id: 7, url: "chrome://settings" }]);
    web.tabsSendMessage.mockResolvedValue(undefined);
    await boot();
    await flush();
    expect(document.querySelector(".site-rule-current")).toBeNull();
    expect(document.body.textContent).not.toContain("当前站点：");
  });
});
