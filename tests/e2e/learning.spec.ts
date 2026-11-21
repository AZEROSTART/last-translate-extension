/**
 * End-to-end coverage for the learning loop: hover a glossary word, click the
 * claim effect to claim it, then review it in the side panel and confirm the
 * schedule advanced and the due badge cleared. A second case reopens the card
 * on an already-claimed word and expects the quiet "known" end state.
 *
 * The launch/profile/server plumbing lives in `harness.ts`; each test owns its
 * profile, fixture server and page so a failed assertion cannot leak a browser.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
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

/** Click the card's claim effect and wait for the claim to land. */
async function claim(card: Locator): Promise<void> {
  await card.locator('[data-ilmt-effect="gopher-hole"] button').click();
  await expect(card.locator('[data-ilmt-effect="gopher-hole"]')).toHaveAttribute(
    "data-ilmt-state",
    "settled",
  );
}

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
  async function openClaimCard(pinEffect?: string): Promise<{
    extension: Extension;
    page: Page;
    rect: { x: number; y: number };
  }> {
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
    const ext = await launchExtension();
    extension = ext;
    await seedSettings(ext.worker, server.origin);
    if (pinEffect) {
      await ext.worker.evaluate(async (effectId) => {
        const stored = await chrome.storage.local.get("settings");
        const settings = stored.settings as Record<string, unknown>;
        settings.mascot = {
          mode: "fixed",
          fixedId: effectId,
          enabledIds: [effectId],
          animations: true,
        };
        await chrome.storage.local.set({ settings });
      }, pinEffect);
    }

    const page = await ext.context.newPage();
    await page.goto(`${server.origin}/${ARTICLE}`);
    await activate(ext.worker, await activeTabId(ext.worker, page.url()));
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

    return { extension: ext, page, rect };
  }

  test("captures a hovered word and reviews it from the side panel", async () => {
    try {
      const { extension: ext, page } = await openClaimCard();
      const extensionId = new URL(ext.worker.url()).host;
      const card = page.locator("[role=tooltip]");

      const claimedAt = Date.now();
      await claim(card);

      const words = await readWords(ext.worker);
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
      expect(await ext.worker.evaluate(async () => chrome.action.getBadgeText({}))).toBe("");

      // Pretend ten minutes passed: the review queue only holds due cards.
      await ext.worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get("learning")).learning as {
          words: Array<{ dueAt: number | null }>;
        };
        stored.words[0].dueAt = Date.now() - 1000;
        await chrome.storage.local.set({ learning: stored });
      });

      const panel = await ext.context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await expect(panel.locator('.panel-tab[data-view="review"]')).toContainText("复习 (1)");
      await panel.locator('.panel-tab[data-view="review"]').click();

      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await expect(panel.locator(".ilmt-review-sentence")).toContainText("____");
      await expect(panel.locator(".ilmt-review-meaning")).toHaveCount(0);
      await panel.locator('[data-grade="good"]').click();
      await expect(panel.locator(".ilmt-review-meaning")).toContainText("比……存在得更久");
      expect((await readWords(ext.worker))[0].box).toBe(0);
      await panel.locator(".ilmt-review-next").click();
      await expect.poll(async () => (await readWords(ext.worker))[0]?.box).toBe(1);
      // The remembered path never asks the model for a picture.
      const remembered = await readWords(ext.worker);
      expect(remembered[0].mnemonic).toBeUndefined();
      await expect(panel.locator(".ilmt-review-receipt")).toContainText("outlive");
      await expect(panel.locator(".ilmt-review-receipt")).toContainText("明天再见");
      await expect(panel.locator(".ilmt-review-done")).toContainText("1 个都过完了");
      await expect(panel.locator(".ilmt-review-done")).not.toContainText("认识");
      await expect(panel.locator(".ilmt-review-done")).not.toContainText("答对");

      // Answering advanced the card past today, so the badge is cleared.
      await expect
        .poll(async () => ext.worker.evaluate(async () => chrome.action.getBadgeText({})), {
          timeout: 10_000,
        })
        .toBe("");
    } finally {
      await cleanup();
    }
  });

  test("shows the size of the library once the first word is kept", async () => {
    try {
      const { extension: ext, page } = await openClaimCard();
      const extensionId = new URL(ext.worker.url()).host;
      await claim(page.locator("[role=tooltip]"));

      const panel = await ext.context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await panel.locator('.panel-tab[data-view="review"]').click();

      await expect(panel.locator(".ilmt-review-shelf")).toHaveText("已收录 1 个");
      await expect(panel.locator(".ilmt-review-shelf")).not.toContainText("已毕业");
    } finally {
      await cleanup();
    }
  });

  test("graduates the last due word and clears the badge", async () => {
    try {
      const { extension: ext, page } = await openClaimCard();
      const extensionId = new URL(ext.worker.url()).host;
      await claim(page.locator("[role=tooltip]"));

      // One 认识 away from graduating, and due right now.
      await ext.worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get("learning")).learning as {
          words: Array<{ box: number; dueAt: number | null }>;
        };
        stored.words[0].box = 5;
        stored.words[0].dueAt = Date.now() - 1000;
        await chrome.storage.local.set({ learning: stored });
      });

      const panel = await ext.context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await expect(panel.locator('.panel-tab[data-view="review"]')).toContainText("复习 (1)");
      await panel.locator('.panel-tab[data-view="review"]').click();

      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await panel.locator('[data-grade="good"]').click();
      await panel.locator(".ilmt-review-next").click();

      await expect(panel.locator(".ilmt-review-done")).toContainText("1 个都过完了");
      await expect(panel.locator(".ilmt-review-receipt")).toContainText("已毕业");
      await expect(panel.locator(".ilmt-review-graduated-word")).toHaveText("outlive 毕业了");
      await expect(panel.locator(".ilmt-review-shelf")).toHaveText("已收录 1 个 · 已毕业 1 个");
      await expect
        .poll(() =>
          ext.worker.evaluate(async () => {
            const stored = (await chrome.storage.local.get("learning")).learning as
              | { words?: Array<{ status?: string }> }
              | undefined;
            return stored?.words?.[0]?.status ?? "";
          }),
        )
        .toBe("mastered");
      await expect
        .poll(async () => ext.worker.evaluate(async () => chrome.action.getBadgeText({})), {
          timeout: 10_000,
        })
        .toBe("");
    } finally {
      await cleanup();
    }
  });

  test("tells a returning user the truth about the gap and about today", async () => {
    try {
      const { extension: ext, page } = await openClaimCard();
      const extensionId = new URL(ext.worker.url()).host;
      await claim(page.locator("[role=tooltip]"));

      // One due word, last reviewed five local days ago.
      await ext.worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get("learning")).learning as {
          words: Array<{ dueAt: number | null }>;
          stats: { day: string; todayReviewed: number };
        };
        stored.words[0].dueAt = Date.now() - 1000;
        const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        const local = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;
        stored.stats = { day: local, todayReviewed: 4 };
        await chrome.storage.local.set({ learning: stored });
      });

      const panel = await ext.context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await panel.locator('.panel-tab[data-view="review"]').click();

      await expect(panel.locator(".ilmt-review-return")).toContainText("有 5 天没见了");
      await panel.locator(".ilmt-review-end").click();

      await expect(panel.locator(".ilmt-review-done-title")).toHaveText("本轮先到这");
      await expect(panel.locator(".ilmt-review-done-today")).toHaveText("今天已复习 0 个");
      await expect(panel.locator(".ilmt-review-done")).not.toContainText("今天已复习 4 个");
    } finally {
      await cleanup();
    }
  });

  test("undoes the last review and returns the same card", async () => {
    try {
      const { extension: ext, page } = await openClaimCard();
      const extensionId = new URL(ext.worker.url()).host;
      await claim(page.locator("[role=tooltip]"));

      // Pretend ten minutes passed, and remember the due time we are rolling back to.
      const beforeDueAt = await ext.worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get("learning")).learning as {
          words: Array<{ dueAt: number | null }>;
        };
        stored.words[0].dueAt = Date.now() - 5000;
        await chrome.storage.local.set({ learning: stored });
        return stored.words[0].dueAt;
      });

      const panel = await ext.context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await expect(panel.locator('.panel-tab[data-view="review"]')).toContainText("复习 (1)");
      await panel.locator('.panel-tab[data-view="review"]').click();

      await panel.locator('[data-grade="good"]').click();
      await panel.locator(".ilmt-review-next").click();

      await expect
        .poll(async () => (await readWords(ext.worker))[0]?.box, { timeout: 10_000 })
        .toBe(1);
      const graded = await readWords(ext.worker);
      expect(graded).toHaveLength(1);
      expect(graded[0].dueAt).toBeGreaterThan(beforeDueAt ?? 0);

      const receipt = panel.locator(".ilmt-review-receipt");
      await expect(receipt).toContainText("outlive");
      await expect(receipt).toContainText("比……存在得更久");
      await expect(receipt).toContainText("明天再见");

      await panel.locator(".ilmt-review-receipt-undo").click();

      await expect
        .poll(async () => (await readWords(ext.worker))[0]?.box, { timeout: 10_000 })
        .toBe(0);
      const undone = await readWords(ext.worker);
      expect(undone).toHaveLength(1);
      expect(undone[0].dueAt).toBe(beforeDueAt);
      await expect(panel.locator(".ilmt-review-receipt")).toHaveCount(0);
      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await expect(panel.getByRole("button", { name: "想起来了", exact: true })).toBeVisible();
      await expect(panel.locator(".ilmt-review-meaning")).toHaveCount(0);
      await expect(panel.locator('.panel-tab[data-view="review"]')).toContainText("复习 (1)");
    } finally {
      await cleanup();
    }
  });

  test("teaches a missed word and asks it again in ten minutes", async () => {
    try {
      const { extension: ext, page } = await openClaimCard();
      const extensionId = new URL(ext.worker.url()).host;
      await claim(page.locator("[role=tooltip]"));

      // Pretend ten minutes passed.
      await ext.worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get("learning")).learning as {
          words: Array<{ dueAt: number | null }>;
        };
        stored.words[0].dueAt = Date.now() - 1000;
        await chrome.storage.local.set({ learning: stored });
      });

      const panel = await ext.context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html`);
      await panel.locator('.panel-tab[data-view="review"]').click();

      const missedAt = Date.now();
      await panel.locator('[data-grade="again"]').click();

      await expect
        .poll(async () => (await readWords(ext.worker))[0]?.box, { timeout: 10_000 })
        .toBe(0);
      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await expect(panel.locator(".ilmt-review-lesson")).toBeVisible();
      await expect(panel.locator(".ilmt-review-scene-caption")).toContainText(
        "outlive 被猫抱进了怀里",
      );
      await expect(panel.locator(".ilmt-review-receipt")).toHaveCount(0);
      await panel.locator(".ilmt-review-next").click();

      await expect(panel.locator(".ilmt-review-receipt")).toContainText("10 分钟后再见");
      await expect(panel.locator(".ilmt-review-done")).toContainText("1 个都过完了");
      await expect(panel.locator(".ilmt-review-done")).toContainText("1 个没想起来");
      await expect.poll(async () => (await readWords(ext.worker))[0]?.box).toBe(0);

      const missed = (await readWords(ext.worker))[0];
      expect(missed.dueAt).toBeGreaterThanOrEqual(missedAt + TEN_MINUTES - 5000);
      expect(missed.dueAt).toBeLessThanOrEqual(Date.now() + TEN_MINUTES + 5000);

      // The picture is cached on the word so the next review needs no model.
      await expect
        .poll(async () => (await readWords(ext.worker))[0]?.mnemonic?.caption)
        .toBe("outlive 被猫抱进了怀里");
    } finally {
      await cleanup();
    }
  });

  test("marks a word already captured and never writes it twice", async () => {
    try {
      const { extension: ext, page, rect } = await openClaimCard();
      const card = page.locator("[role=tooltip]");

      await claim(card);
      expect(await readWords(ext.worker)).toHaveLength(1);

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
      expect(await readWords(ext.worker)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("claims with the pinned cat and half-opens one eye on return", async () => {
    try {
      const { extension: ext, page, rect } = await openClaimCard("cat-hoard");
      const card = page.locator("[role=tooltip]");
      const cat = card.locator('[data-ilmt-effect="cat-hoard"]');

      await expect(cat).toBeVisible();
      await cat.locator("button").click();
      await expect(cat).toHaveAttribute("data-ilmt-state", "settled");
      const words = await readWords(ext.worker);
      expect(words.map((word) => word.mascotId)).toEqual(["cat-hoard"]);

      // Back on the same word: the card must show the quiet known state.
      await page.mouse.move(0, 0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);
      await page.mouse.move(rect.x, rect.y);
      const again = page.locator("[role=tooltip]");
      await expect(again.locator('[data-ilmt-effect="cat-hoard"]')).toHaveAttribute(
        "data-ilmt-state",
        "known",
      );
      expect(await readWords(ext.worker)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("claims with the pinned photo sticker and dims it on return", async () => {
    try {
      const { extension: ext, page, rect } = await openClaimCard("cat-sticker");
      const card = page.locator("[role=tooltip]");
      const sticker = card.locator('[data-ilmt-effect="cat-sticker"]');

      await expect(sticker).toBeVisible();
      // The cut-out is inlined, so it must decode even though no asset file is
      // shipped: a broken data URI would still render an empty box here.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const img = document.querySelector<HTMLImageElement>(
              '[data-ilmt-effect="cat-sticker"] img',
            );
            return img?.naturalWidth ?? 0;
          }),
        )
        .toBeGreaterThan(0);

      await sticker.locator("button").click();
      await expect(sticker).toHaveAttribute("data-ilmt-state", "settled");
      const words = await readWords(ext.worker);
      expect(words.map((word) => word.mascotId)).toEqual(["cat-sticker"]);

      await page.mouse.move(0, 0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);
      await page.mouse.move(rect.x, rect.y);
      const again = page.locator("[role=tooltip]");
      await expect(again.locator('[data-ilmt-effect="cat-sticker"]')).toHaveAttribute(
        "data-ilmt-state",
        "known",
      );
      expect(await readWords(ext.worker)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("recalls a reviewed word from its original sentence and commits after confirmation", async () => {
    try {
      const { extension: ext, page } = await openClaimCard();
      await claim(page.locator("[role=tooltip]"));
      await ext.worker.evaluate(async () => {
        const { learning } = await chrome.storage.local.get("learning") as {
          learning: { words: Array<{ box: number; reviewsCount: number; dueAt: number }> };
        };
        Object.assign(learning.words[0], { box: 1, reviewsCount: 1, dueAt: Date.now() - 1000 });
        await chrome.storage.local.set({ learning });
      });

      const panel = await ext.context.newPage();
      await panel.goto(`chrome-extension://${new URL(ext.worker.url()).host}/panel.html`);
      await panel.locator('.panel-tab[data-view="review"]').click();
      const card = panel.locator(".ilmt-review-card");
      await expect(card).toContainText("原句找词");
      await expect(card).toContainText("比……存在得更久");
      await expect(card).not.toContainText(/outlive/i);
      await expect(card.locator(".ilmt-review-sentence")).toContainText("____");
      const input = card.getByRole("textbox", { name: "填写原词" });
      await input.fill("OUTLIVE");
      await input.press("Enter");
      await expect(card.getByRole("status")).toHaveText("拼写一致");
      await expect(card.locator(".ilmt-review-sentence")).toContainText("outlive");
      await card.getByRole("button", { name: "想起来了", exact: true }).click();
      expect((await readWords(ext.worker))[0].box).toBe(1);
      await card.getByRole("button", { name: "下一张" }).click();
      await expect.poll(async () => (await readWords(ext.worker))[0].box).toBe(2);
      await expect(panel.locator(".ilmt-review-done")).toContainText("1 个都过完了");
    } finally {
      await cleanup();
    }
  });
});
