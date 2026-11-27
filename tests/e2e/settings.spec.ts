/**
 * The settings page can preview a claim effect without touching the learning
 * store: "试一试" mounts a throwaway effect whose claim is a local stub, so the
 * word is never captured. Mirrors the flow a user takes in
 * `popup.html?mode=page`.
 */

import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { startMockServer, type MockServer } from "../mock-server";
import {
  activate,
  activeTabId,
  evaluateInContent,
  findContentMainContext,
  launchExtension,
  seedSettings,
  type Extension,
} from "./harness";

test("previews a claim effect without claiming a word", async () => {
  let extension: Extension | undefined;
  let server: MockServer | undefined;
  try {
    extension = await launchExtension();
    server = await startMockServer();
    await seedSettings(extension.worker, server.origin);
    const extensionId = new URL(extension.worker.url()).host;

    const page = await extension.context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html?mode=page`);

    // Only the model section starts open, so the learning section's preview
    // button is not reachable until its accordion is expanded.
    await page.locator('details[data-section="learning"] summary').click();
    // Nothing is mounted until "试一试" opens exactly one preview slot.
    await expect(page.locator(".effect-preview:not([hidden])")).toHaveCount(0);

    for (const effectId of ["gopher-hole", "magnet", "cat-hoard", "cat-sticker"]) {
      const tryButton = page.locator(`.effect-try[data-effect="${effectId}"]`);
      await tryButton.click();

      const preview = page.locator(".effect-preview:not([hidden])");
      const root = preview.locator(`[data-ilmt-effect="${effectId}"]`);
      await expect(root).toBeVisible();
      // Exactly one preview slot is open, whichever effect it holds.
      await expect(page.locator(".effect-preview:not([hidden])")).toHaveCount(1);
      await root.locator("button").click();
      await expect(root).toHaveAttribute("data-ilmt-state", "settled");

      // Close the slot again so the next effect starts from a clean state.
      await tryButton.click();
      await expect(page.locator(".effect-preview:not([hidden])")).toHaveCount(0);
    }

    const stored = await extension.worker.evaluate(async () => chrome.storage.local.get("learning"));
    expect(stored.learning).toBeUndefined();
  } finally {
    await extension?.context.close().catch(() => {});
    if (extension) await rm(extension.userDataDir, { recursive: true, force: true }).catch(() => {});
    await server?.close().catch(() => {});
  }
});

test("applies the theme live and lets a dark page choose its hover card", async () => {
  let extension: Extension | undefined;
  let server: MockServer | undefined;
  try {
    extension = await launchExtension();
    server = await startMockServer({
      glossary: (index) =>
        index === 1
          ? [{ surface: "outlive", pos: "v.", meaning: "比……存在得更久" }]
          : undefined,
    });
    await seedSettings(extension.worker, server.origin);
    const extensionId = new URL(extension.worker.url()).host;

    const popup = await extension.context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?mode=page`);
    await popup.locator('details[data-section="advanced"] summary').click();
    await popup.locator(".global-theme").selectOption("dark");

    await expect
      .poll(() =>
        extension!.worker.evaluate(async () => {
          const stored = (await chrome.storage.local.get("settings")).settings as {
            theme?: string;
          };
          return stored.theme;
        }),
      )
      .toBe("dark");
    await expect(popup.locator("html")).toHaveAttribute("data-theme-mode", "dark");
    await expect(popup.locator("html")).toHaveAttribute("data-theme", "quantum");

    const panel = await extension.context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await expect(panel.locator("html")).toHaveAttribute("data-theme-mode", "dark");
    await expect(panel.locator("html")).toHaveAttribute("data-theme", "quantum");

    // Back to system so the hover card has to read the page itself.
    await extension.worker.evaluate(async () => {
      const stored = (await chrome.storage.local.get("settings")).settings as Record<
        string,
        unknown
      >;
      await chrome.storage.local.set({ settings: { ...stored, theme: "system" } });
    });

    const article = await extension.context.newPage();
    await article.goto(`${server.origin}/article.html`);
    await article.evaluate(() => {
      document.body.style.backgroundColor = "rgb(10, 12, 16)";
      document.body.style.color = "rgb(240, 240, 240)";
    });
    const tabId = await activeTabId(extension.worker, article.url());
    await activate(extension.worker, tabId);
    const content = await findContentMainContext(article);
    await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
    await expect(article.locator(".ilmt-tr")).toHaveCount(10);
    await expect(article.locator(".ilmt-active-banner")).toContainText("1 个词可悬停");
    await article.bringToFront();

    const rect = await article.evaluate(() => {
      const paragraph = document.querySelector("#article-p1")!;
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        const index = text.data.indexOf("outlive");
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + "outlive".length);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      return null;
    });
    expect(rect).not.toBeNull();
    await article.mouse.move(rect!.x, rect!.y, { steps: 3 });
    const card = article.locator("[role=tooltip]");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-theme", "dark");
  } finally {
    await extension?.context.close().catch(() => {});
    if (extension) await rm(extension.userDataDir, { recursive: true, force: true }).catch(() => {});
    await server?.close().catch(() => {});
  }
});
