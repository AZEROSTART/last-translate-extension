/**
 * End-to-end coverage for the learning loop: hover a glossary word, click the
 * claim effect to claim it, then review it in the side panel and confirm the
 * schedule advanced and the due badge cleared. A second case reopens the card
 * on an already-claimed word and expects the quiet "known" end state.
 *
 * The launch/profile/server plumbing lives in `harness.ts`; each test owns its
 * profile, fixture server and page so a failed assertion cannot leak a browser.
 */

import { test, expect, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import { startMockServer, type MockServer } from "../mock-server";
import {
  activate,
  activeTabId,
  ARTICLE,
  evaluateInContent,
  findContentMainContext,
  launchExtension,
  readWords,
  seedSettings,
  TEN_MINUTES,
  type Extension,
} from "./harness";

/** Viewport centre of `word` inside the first article paragraph. */
async function wordRect(page: Page, word: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((needle) => {
    const paragraph = document.querySelector("#article-p1")!;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const index = text.data.indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + needle.length);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  }, word);
}

test.describe("learning loop", () => {
  let server: MockServer | undefined;
  let extension: Extension | undefined;

  async function cleanup(): Promise<void> {
    const currentExtension = extension;
    const currentServer = server;
    extension = undefined;
    server = undefined;

    if (currentExtension) {
      await currentExtension.context.close().catch(() => {});
      await rm(currentExtension.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
    await currentServer?.close().catch(() => {});
  }

  /** Fixture server + extension + translated article, hovering `outlive`. */
  async function openClaimCard(): Promise<{ page: Page; rect: { x: number; y: number } }> {
    server = await startMockServer({
      glossary: (index) =>
        index === 1
          ? [
              {
                surface: "outlive",
                pos: "v.",
                meaning: "比……存在得更久",
                example: "Small tools often outlive their larger competitors.",
                glosses: { es: "sobrevivir a" },
              },
            ]
          : undefined,
    });
    extension = await launchExtension();
    await seedSettings(extension.worker, server.origin);

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/${ARTICLE}`);
    await activate(extension.worker, await activeTabId(extension.worker, page.url()));
    const content = await findContentMainContext(page);
    await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
    await expect(page.locator(".ilmt-tr")).toHaveCount(10);
    await expect(page.locator('.ilmt-tr[data-loading="1"]')).toHaveCount(0);
    await expect(page.locator(".ilmt-active-banner")).toContainText("1 个词可悬停");

    const rect = await wordRect(page, "outlive");
    expect(rect).not.toBeNull();
    if (!rect) throw new Error("outlive is not on the page");

    await page.mouse.move(rect.x, rect.y);
    const card = page.locator("[role=tooltip]");
    await expect(card).toContainText("outlive");
    await expect(card).toContainText("比……存在得更久");

    return { page, rect };
  }

  test("captures a hovered word and reviews it from the side panel", async () => {
    try {
      const { page } = await openClaimCard();
      const extensionId = new URL(extension!.worker.url()).host;
      const card = page.locator("[role=tooltip]");

      // The effect button is the only interactive element on the card.
      const claimedAt = Date.now();
      await card.locator("button[aria-label]").click();
      const effect = card.locator('[data-ilmt-effect="gopher-hole"]');
      await expect(effect).toHaveAttribute("data-ilmt-state", "settled");

      const words = await readWords(extension!.worker);
      expect(words).toHaveLength(1);
      const word = words[0];
      expect(word.id).toBe("en:outlive");
      expect(word.surface).toBe("outlive");
      expect(word.termLang).toBe("en");
      expect(word.box).toBe(0);
      expect(word.mascotId).toBe("gopher-hole");
      expect(word.dueAt).toBeGreaterThanOrEqual(claimedAt + TEN_MINUTES - 5000);
      expect(word.dueAt).toBeLessThanOrEqual(Date.now() + TEN_MINUTES + 5000);
      expect(word.glosses.map((gloss) => gloss.lang).sort()).toEqual(["es", "zh-CN"]);

      // Nothing is due yet, so the badge stays hidden.
      expect(await extension!.worker.evaluate(async () => chrome.action.getBadgeText({}))).toBe("");

      // Pretend ten minutes passed: the review queue only holds due cards.
      await extension!.worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get("learning")).learning as {
          words: Array<{ dueAt: number | null }>;
        };
        stored.words[0].dueAt = Date.now() - 1000;
        await chrome.storage.local.set({ learning: stored });
      });

      const panel = await extension!.context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await expect(panel.locator('.panel-tab[data-view="review"]')).toContainText("复习 (1)");
      await panel.locator('.panel-tab[data-view="review"]').click();

      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await expect(panel.locator(".ilmt-review-sentence")).toContainText("____");
      await panel.locator('[data-grade="good"]').click();

      // The card stays put and opens the answer; nothing is written yet.
      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await expect(panel.locator(".ilmt-review-meaning")).toContainText("比……存在得更久");
      await expect(panel.locator(".ilmt-review-meaning-more")).toContainText("sobrevivir a");
      await expect(panel.locator(".ilmt-review-next")).toBeVisible();
      await expect
        .poll(async () => (await readWords(extension!.worker))[0]?.box)
        .toBe(0);

      await panel.locator(".ilmt-review-next").click();

      await expect
        .poll(async () => (await readWords(extension!.worker))[0]?.box, { timeout: 10_000 })
        .toBe(1);
      await expect(panel.locator(".ilmt-review-done")).toContainText("今天没有要复习的词");

      // Answering advanced the card past today, so the badge is cleared.
      await expect
        .poll(async () => extension!.worker.evaluate(async () => chrome.action.getBadgeText({})), {
          timeout: 10_000,
        })
        .toBe("");
    } finally {
      await cleanup();
    }
  });

  test("marks a word already captured and never writes it twice", async () => {
    try {
      const { page, rect } = await openClaimCard();
      const card = page.locator("[role=tooltip]");

      await card.locator("button[aria-label]").click();
      await expect(card.locator('[data-ilmt-effect="gopher-hole"]')).toHaveAttribute(
        "data-ilmt-state",
        "settled",
      );
      expect(await readWords(extension!.worker)).toHaveLength(1);

      // Move away and wait for the card to retire, then hover the same word:
      // the reopened card must show the quiet "known" state instead of "+1".
      await page.mouse.move(0, 0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);
      await page.mouse.move(rect.x, rect.y);

      const again = page.locator("[role=tooltip]");
      await expect(again.locator('[data-ilmt-effect="gopher-hole"]')).toHaveAttribute(
        "data-ilmt-state",
        "known",
      );
      expect(await readWords(extension!.worker)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
