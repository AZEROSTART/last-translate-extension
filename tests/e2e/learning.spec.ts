/**
 * End-to-end coverage for the learning loop: hover a glossary word, click the
 * mascot to claim it, then review it in the side panel and confirm the schedule
 * advanced and the due badge cleared.
 *
 * Helpers mirror `translate.spec.ts`; each test owns its profile, fixture
 * server and page so a failed assertion cannot leak a browser.
 */

import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockServer, type MockServer } from "../mock-server";

const EXTENSION_PATH = resolve("dist");
const ARTICLE = "article.html";
const TEN_MINUTES = 10 * 60 * 1000;

interface Extension {
  context: BrowserContext;
  worker: Worker;
  userDataDir: string;
}

async function launchExtension(): Promise<Extension> {
  const userDataDir = await mkdtemp(join(tmpdir(), "ilmt-e2e-"));
  const channel = process.env.ILMT_E2E_CHANNEL;
  const headless = process.env.ILMT_E2E_HEADLESS === "1";

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      ...(channel ? { channel } : headless ? { channel: "chromium" } : {}),
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
    return { context, worker, userDataDir };
  } catch (error) {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function seedSettings(worker: Worker, baseURL: string): Promise<void> {
  await worker.evaluate(async (origin) => {
    await chrome.storage.local.set({
      settings: {
        providers: [
          {
            id: "e2e",
            name: "E2E",
            kind: "custom",
            baseURL: origin,
            apiKey: "test",
            model: "mock-model",
            createdAt: 1,
          },
        ],
        activeProviderId: "e2e",
        targetLang: "zh-CN",
        concurrency: 3,
        maxRPS: 5,
        temperature: 0,
        systemPrompt:
          "Translate each numbered segment into {{targetLang}}. Reply only with [n] text, one line per segment.",
        promptVersion: "",
        triggerMode: "shortcut",
        siteRules: {},
        theme: "system",
        glossaryEnabled: true,
        learningLangs: ["en", "es"],
        mascot: { mode: "rotate", enabledIds: ["gopher"], animations: true },
        reviewAnswerLang: "",
      },
    });
    await chrome.storage.local.remove("learning");
  }, baseURL);
}

async function activeTabId(worker: Worker, pageUrl: string): Promise<number> {
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    return tab?.id;
  }, pageUrl);

  if (tabId === undefined) throw new Error(`no extension tab found for ${pageUrl}`);
  return tabId;
}

async function activate(worker: Worker, tabId: number): Promise<void> {
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "activate" }), tabId);
}

/** Find the content script's isolated world via CDP, like `translate.spec.ts`. */
async function findContentMainContext(page: Page): Promise<{ session: CDPSession; contextId: number }> {
  const session = await page.context().newCDPSession(page);
  const contextIds = new Set<number>();

  session.on("Runtime.executionContextCreated", (event) => {
    contextIds.add(event.context.id);
  });
  await session.send("Runtime.enable");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const contextId of contextIds) {
      try {
        const { result } = await session.send("Runtime.evaluate", {
          expression: "typeof globalThis.__ilmtMain",
          contextId,
          returnByValue: true,
        });
        if (result.value === "object") return { session, contextId };
      } catch {
        // The context was destroyed between enumeration and evaluation.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("content main did not expose __ilmtMain in any execution context");
}

async function evaluateInContent<T>(
  context: { session: CDPSession; contextId: number },
  expression: string,
): Promise<T> {
  const { result, exceptionDetails } = await context.session.send("Runtime.evaluate", {
    expression,
    contextId: context.contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text ?? "content-script evaluation failed");
  }
  return result.value as T;
}

interface StoredWord {
  id: string;
  termLang: string;
  surface: string;
  box: number;
  dueAt: number | null;
  mascotId?: string;
  glosses: Array<{ lang: string; meaning: string }>;
}

async function readWords(worker: Worker): Promise<StoredWord[]> {
  return worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get("learning")).learning as
      | { words?: StoredWord[] }
      | undefined;
    return stored?.words ?? [];
  });
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

  test("captures a hovered word and reviews it from the side panel", async () => {
    try {
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
      const extensionId = new URL(extension.worker.url()).host;

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLE}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      const content = await findContentMainContext(page);
      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(10);
      await expect(page.locator('.ilmt-tr[data-loading="1"]')).toHaveCount(0);
      await expect(page.locator(".ilmt-active-banner")).toContainText("1 个词可悬停");

      const rect = await page.evaluate(() => {
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

      await page.mouse.move(rect!.x, rect!.y);
      const card = page.locator("[role=tooltip]");
      await expect(card).toContainText("outlive");
      await expect(card).toContainText("比……存在得更久");

      // The mascot button is the only interactive element on the card.
      const claimedAt = Date.now();
      await card.locator("button[aria-label]").click();
      await expect(card).toContainText("已抓住");

      const words = await readWords(extension.worker);
      expect(words).toHaveLength(1);
      const word = words[0];
      expect(word.id).toBe("en:outlive");
      expect(word.surface).toBe("outlive");
      expect(word.termLang).toBe("en");
      expect(word.box).toBe(0);
      expect(word.mascotId).toBe("gopher");
      expect(word.dueAt).toBeGreaterThanOrEqual(claimedAt + TEN_MINUTES - 5000);
      expect(word.dueAt).toBeLessThanOrEqual(Date.now() + TEN_MINUTES + 5000);
      expect(word.glosses.map((gloss) => gloss.lang).sort()).toEqual(["es", "zh-CN"]);

      // Nothing is due yet, so the badge stays hidden.
      expect(await extension.worker.evaluate(async () => chrome.action.getBadgeText({}))).toBe("");

      // Pretend ten minutes passed: the review queue only holds due cards.
      await extension.worker.evaluate(async () => {
        const stored = (await chrome.storage.local.get("learning")).learning as {
          words: Array<{ dueAt: number | null }>;
        };
        stored.words[0].dueAt = Date.now() - 1000;
        await chrome.storage.local.set({ learning: stored });
      });

      const panel = await extension.context.newPage();
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
});
