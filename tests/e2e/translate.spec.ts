/**
 * End-to-end coverage for the loaded MV3 extension: translate + restore on an
 * English article, the command/activate path, and the zero-request language
 * skip on an already-Chinese page.
 *
 * Each test owns its Chromium profile, fixture/mock server and page. Every test
 * cleans both up in a `finally`, so a failed assertion cannot leak a browser.
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
const ARTICLES = {
  english: "article.html",
  chinese: "chinese.html",
  granularity: "granularity.html",
} as const;

interface Extension {
  context: BrowserContext;
  worker: Worker;
  userDataDir: string;
}

async function launchExtension(): Promise<Extension> {
  const userDataDir = await mkdtemp(join(tmpdir(), "ilmt-e2e-"));
  // Escape hatch for machines that cannot download Playwright's Chromium but
  // do have a branded Chrome installed: ILMT_E2E_CHANNEL=chrome.
  // Set ILMT_E2E_HEADLESS=1 to verify without taking focus; new headless needs
  // the full Chromium build, not Playwright's separate headless shell.
  const channel = process.env.ILMT_E2E_CHANNEL;
  const headless = process.env.ILMT_E2E_HEADLESS === "1";

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      // MV3 extensions need a persistent context. Old headless cannot load
      // extensions; new headless plus the full Chromium build can.
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
      },
    });
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

/**
 * `__ilmtMain` lives in the content script's isolated world, which
 * `page.evaluate` (main world) cannot see. Find the execution context that owns
 * the hook via CDP, polling until `activate` has loaded content_main.
 */
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

/** Evaluate an expression in the content script's isolated world. */
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

test.describe("loaded extension", () => {
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

  /**
   * Watch for a provider request for a bounded settle window instead of
   * sampling once. A delayed request anywhere in the window fails.
   */
  async function expectNoProviderRequests(page: Page, mockServer: MockServer): Promise<void> {
    const deadline = Date.now() + 500;
    do {
      expect(mockServer.requests).toHaveLength(0);
      await page.waitForTimeout(50);
    } while (Date.now() < deadline);
    expect(mockServer.requests).toHaveLength(0);
  }

  test("translates an English article and restores it", async () => {
    try {
      server = await startMockServer();
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLES.english}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      const content = await findContentMainContext(page);

      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(10);
      await expect(page.locator(".ilmt-tr").first()).toContainText("译文");
      expect(server.requests.some((request) => request.method === "POST")).toBe(true);

      await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("skips secondary regions and short labels by default", async () => {
    try {
      server = await startMockServer();
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLES.granularity}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      const content = await findContentMainContext(page);
      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");

      await expect(page.locator(".ilmt-tr")).toHaveCount(4);
      await expect(page.locator('.ilmt-tr[data-loading="1"]')).toHaveCount(0);
      expect(
        await page.locator(".ilmt-tr").evaluateAll((nodes) =>
          nodes.map((node) => node.parentElement?.tagName ?? "").sort(),
        ),
      ).toEqual(["H1", "LI", "P", "TD"]);
      await expect(page.locator("aside .ilmt-tr, small .ilmt-tr, figcaption .ilmt-tr")).toHaveCount(0);
      await expect(page.locator(".breadcrumb .ilmt-tr, .post-meta .ilmt-tr")).toHaveCount(0);
      await expect(page.locator("#short-label .ilmt-tr")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("shows granularity defaults in options and the active provider in popup", async () => {
    try {
      server = await startMockServer();
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);
      const extensionId = new URL(extension.worker.url()).host;

      const optionsPage = await extension.context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(optionsPage.locator(".global-minParagraphLength")).toHaveValue("10");
      await expect(optionsPage.locator(".global-contentOnly")).toBeChecked();

      const popupPage = await extension.context.newPage();
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popupPage.locator(".popup-title")).toHaveText("翻译设置");
      await expect(popupPage.locator(".popup-provider-select")).toContainText("E2E");
      await expect(popupPage.locator(".popup-model")).toHaveValue("mock-model");
    } finally {
      await cleanup();
    }
  });

  test("translates on one activate and restores on the next", async () => {
    try {
      server = await startMockServer();
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLES.english}`);
      const tabId = await activeTabId(extension.worker, page.url());

      // A single press must load content_main and translate the page. Do not
      // call the exposed test hook or send a second activate.
      await activate(extension.worker, tabId);
      await expect(page.locator(".ilmt-tr")).toHaveCount(10);
      await expect(page.locator(".ilmt-tr").first()).toContainText("译文");
      await expect(page.locator(".ilmt-active-banner")).toContainText("翻译已开启");
      expect(server.requests.some((request) => request.method === "POST")).toBe(true);

      // The next press toggles back to the original page.
      await activate(extension.worker, tabId);
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
      await expect(page.locator(".ilmt-active-banner")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("sends no provider requests on an already-Chinese page", async () => {
    try {
      server = await startMockServer();
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLES.chinese}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      // Wait for content_main before judging the request window.
      await findContentMainContext(page);

      await expectNoProviderRequests(page, server);
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("keeps hover notes when the glossary block splits the numbered lines", async () => {
    try {
      server = await startMockServer({
        splitGlossary: true,
        glossary: (index) =>
          index === 1
            ? [{ surface: "outlive", meaning: "比……存在得更久" }]
            : undefined,
      });
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLES.english}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      const content = await findContentMainContext(page);
      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(10);
      await expect(page.locator(".ilmt-active-banner")).toContainText("1 个词可悬停");
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss")?.size ?? 0',
        ),
      ).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("shows a glossary card on hover and clears it on restore", async () => {
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
                },
              ]
            : undefined,
      });
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLES.english}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      const content = await findContentMainContext(page);
      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(10);
      // Loading skeletons also use `.ilmt-tr`; wait for the result (and its
      // banner hint) before checking the highlight registry.
      await expect(page.locator('.ilmt-tr[data-loading="1"]')).toHaveCount(0);
      await expect(page.locator(".ilmt-active-banner")).toContainText("1 个词可悬停");
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss")?.size ?? 0',
        ),
      ).toBeGreaterThan(0);

      const rect = await page.evaluate(() => {
        const p = document.querySelector("#article-p1")!;
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
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
      await expect(page.locator("[role=tooltip]")).toContainText("outlive");
      await expect(page.locator("[role=tooltip]")).toContainText("比……存在得更久");

      await page.mouse.move(0, 0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);

      await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss")?.size ?? 0',
        ),
      ).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
