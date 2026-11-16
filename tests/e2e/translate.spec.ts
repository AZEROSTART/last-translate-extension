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
  long: "long.html",
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

async function seedSettings(
  worker: Worker,
  baseURL: string,
  mascot?: {
    mode: "rotate" | "fixed";
    fixedId?: string;
    enabledIds: string[];
    animations: boolean;
  },
): Promise<void> {
  await worker.evaluate(async ({ origin, mascotSettings }) => {
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
        ...(mascotSettings ? { mascot: mascotSettings } : {}),
      },
    });
  }, { origin: baseURL, mascotSettings: mascot });
}

/** Change only the claim effect, keeping every other seeded setting. */
async function setMascot(
  worker: Worker,
  mascot: {
    mode: "rotate" | "fixed";
    fixedId?: string;
    enabledIds: string[];
    animations: boolean;
  },
): Promise<void> {
  await worker.evaluate(async (value) => {
    const stored = (await chrome.storage.local.get("settings")).settings as
      | Record<string, unknown>
      | undefined;
    await chrome.storage.local.set({ settings: { ...stored, mascot: value } });
  }, mascot);
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

  test("advertises the real shortcut bindings without an OS keystroke", async () => {
    try {
      extension = await launchExtension();

      const shortcuts = await extension.worker.evaluate(async () => {
        const commands = await chrome.commands.getAll();
        return Object.fromEntries(commands.map((command) => [command.name, command.shortcut ?? ""]));
      });

      // Chrome resolves the manifest's suggested keys; an empty string means the
      // binding was rejected or overridden, which the OS would swallow silently.
      // macOS reports the Option key as ⌥, other platforms as Alt.
      const key = (name: string) => (shortcuts[name] ?? "").replace("⌥", "Alt+");
      expect(key("translate-page")).toBe("Alt+A");
      expect(key("ask-selection")).toBe("Alt+Q");
      expect(key("toggle-side-panel")).toBe("Alt+S");
    } finally {
      await cleanup();
    }
  });

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

      // 双语：每条原文都还在，译文非空、紧跟在原文之后、位置在原文下方。
      const rows = await page.locator("#article p").evaluateAll((nodes) =>
        nodes.map((node) => {
          const tr = node.querySelector(":scope > .ilmt-tr");
          const clone = node.cloneNode(true) as HTMLElement;
          clone.querySelectorAll(".ilmt-tr").forEach((n) => n.remove());
          return {
            source: clone.textContent?.replace(/\s+/g, " ").trim() ?? "",
            trText: tr?.textContent?.trim() ?? "",
            below: !!tr && tr.getBoundingClientRect().top >= node.getBoundingClientRect().top,
            loading: tr?.getAttribute("data-loading") === "1",
          };
        }),
      );
      expect(rows).toHaveLength(10);
      expect(rows.filter((row) => !row.source || !row.trText || !row.below || row.loading)).toEqual(
        [],
      );
      expect(server.requests.some((request) => request.method === "POST")).toBe(true);

      // 第二次激活走的是命令行/快捷键的同一条路径。
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
      await expect(page.locator("#article p")).toHaveCount(10);
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

  test("shows settings sections and the active provider in the popup", async () => {
    try {
      server = await startMockServer();
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);
      const extensionId = new URL(extension.worker.url()).host;

      const popupPage = await extension.context.newPage();
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popupPage.locator(".popup-title")).toHaveText("翻译设置");
      await expect(popupPage.locator("details.settings-section")).toHaveCount(5);
      await expect(popupPage.locator(".global-minParagraphLength")).toHaveValue("10");
      await expect(popupPage.locator(".global-contentOnly")).toBeChecked();
      await expect(popupPage.locator(".settings-active-provider")).toContainText("E2E");
      await expect(popupPage.locator(".settings-model-summary")).toContainText("mock-model");

      await popupPage.locator(".settings-manage-models").click();
      await expect(popupPage.locator(".provider-card")).toHaveCount(1);
      await expect(popupPage.locator(".provider-card")).toContainText("E2E");
      await popupPage.locator(".settings-back").click();
      await expect(popupPage.locator("details.settings-section")).toHaveCount(5);
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
        reply: (index) =>
          index === 1
            ? "小工具往往比它们更大的竞争对手存在得更久。"
            : "译文",
        glossary: (index) =>
          index === 1
            ? [
                {
                  surface: "outlive",
                  pos: "v.",
                  meaning: "比……存在得更久",
                  example: "Small tools often outlive their larger competitors.",
                  translated: "存在得更久",
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
      await expect(page.locator(".ilmt-active-banner")).not.toContainText("虚线");
      const glossCount = await evaluateInContent<number>(
        content,
        'CSS.highlights?.get("ilmt-gloss")?.size ?? 0',
      );
      expect(glossCount).toBeGreaterThan(0);

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
      await expect(page.locator("[role=tooltip]")).not.toContainText("译 ·");
      await expect(page.locator("[role=tooltip] .ilmt-gloss-example")).toHaveCount(0);

      // The term's translated wording is lit inside this paragraph's translation,
      // and the source highlight keeps exactly the same number of ranges.
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss-pair")?.size ?? 0',
        ),
      ).toBe(1);
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss")?.size ?? 0',
        ),
      ).toBe(glossCount);

      await page.mouse.move(0, 0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss-pair")?.size ?? 0',
        ),
      ).toBe(0);

      await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss")?.size ?? 0',
        ),
      ).toBe(0);
      expect(
        await evaluateInContent<number>(
          content,
          'CSS.highlights?.get("ilmt-gloss-pair")?.size ?? 0',
        ),
      ).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("keeps the hover card inside a narrow viewport for every card size", async () => {
    try {
      server = await startMockServer({
        reply: (index) => (index === 10 ? "最后一段以把工具挂回钩子作结。" : "译文"),
        glossary: (index) =>
          index === 10
            ? [{ surface: "hooks", pos: "n.", meaning: "挂钩", translated: "钩子" }]
            : undefined,
      });
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin, {
        mode: "fixed",
        fixedId: "cat-sticker",
        enabledIds: [],
        animations: false,
      });

      const page = await extension.context.newPage();
      await page.setViewportSize({ width: 320, height: 600 });
      await page.goto(`${server.origin}/${ARTICLES.english}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      const content = await findContentMainContext(page);
      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(10);
      await expect(page.locator('.ilmt-tr[data-loading="1"]')).toHaveCount(0);

      // Room below the article so the last paragraph can be parked mid-viewport,
      // clear of the fixed banner that sits at the bottom edge.
      await page.evaluate(() => {
        const spacer = document.createElement("div");
        spacer.style.height = "500px";
        document.body.appendChild(spacer);
      });

      const termPoint = () =>
        page.evaluate(() => {
          const p = document.querySelector("#article-p10")!;
          const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node as Text;
            const index = text.data.indexOf("hooks");
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(text, index);
            range.setEnd(text, index + "hooks".length);
            const box = range.getBoundingClientRect();
            return {
              x: box.left + box.width / 2,
              y: box.top + box.height / 2,
              top: box.top,
            };
          }
          return null;
        });

      /** Wait for pending scroll events: the card hides on scroll. */
      const settleScroll = async () => {
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await page.waitForTimeout(50);
      };

      const hoverLastTerm = async () => {
        await page.locator("#article-p10").scrollIntoViewIfNeeded();
        const initial = await termPoint();
        expect(initial).not.toBeNull();
        // Park the word mid-viewport so the fixed banner at the bottom can
        // never intercept the pointer.
        await page.evaluate((delta) => window.scrollBy(0, delta), initial!.top - 300);
        await settleScroll();

        const point = await termPoint();
        expect(point).not.toBeNull();
        await page.mouse.move(point!.x, point!.y);
        await expect(page.locator("[role=tooltip]")).toContainText("hooks");
        const box = await page.locator("[role=tooltip]").boundingBox();
        expect(box).not.toBeNull();
        return box!;
      };

      const insideViewport = (box: { x: number; y: number; width: number; height: number }) =>
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= 320 &&
        box.y + box.height <= 600;

      const sticker = await hoverLastTerm();
      expect(insideViewport(sticker)).toBe(true);
      expect(sticker.height).toBeLessThanOrEqual(175);

      await page.mouse.move(0, 0);
      await expect(page.locator("[role=tooltip]")).toHaveCount(0);

      await setMascot(extension.worker, {
        mode: "fixed",
        fixedId: "gopher-hole",
        enabledIds: [],
        animations: false,
      });
      await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
      // Lazy loading only queues the band around the current scroll position,
      // so wait for this paragraph specifically instead of a page-wide count.
      await expect(page.locator("#article-p10 .ilmt-tr")).toHaveCount(1);
      await expect(page.locator('#article-p10 .ilmt-tr[data-loading="1"]')).toHaveCount(0);

      const gopher = await hoverLastTerm();
      expect(insideViewport(gopher)).toBe(true);
      expect(gopher.height).toBeLessThanOrEqual(155);
    } finally {
      await cleanup();
    }
  });

  test("lights only the hovered paragraph's translation", async () => {
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
      await expect(page.locator('.ilmt-tr[data-loading="1"]')).toHaveCount(0);

      await page.locator("#article-p3").hover();
      await expect(page.locator("#article-p3 .ilmt-tr")).toHaveAttribute(
        "data-ilmt-peer",
        "1",
      );
      await expect(page.locator("#article-p2 .ilmt-tr")).not.toHaveAttribute(
        "data-ilmt-peer",
        "1",
      );
      expect(
        await page
          .locator("#article-p3 .ilmt-tr")
          .evaluate((node) => getComputedStyle(node).opacity),
      ).toBe("1");
      expect(await page.locator("[data-ilmt-peer]").count()).toBe(1);

      await page.locator("#article-p5").hover();
      await expect(page.locator("#article-p5 .ilmt-tr")).toHaveAttribute(
        "data-ilmt-peer",
        "1",
      );
      await expect(page.locator("#article-p3 .ilmt-tr")).not.toHaveAttribute(
        "data-ilmt-peer",
        "1",
      );
      const lit = page.locator("[data-ilmt-peer]");
      expect(await lit.count()).toBe(1);
      expect(await lit.getAttribute("data-ilmt-for")).toBe("p_5");

      await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
      await expect(page.locator("[data-ilmt-peer]")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("translates the viewport band first and follows the scroll", async () => {
    try {
      server = await startMockServer();
      extension = await launchExtension();
      await seedSettings(extension.worker, server.origin);

      const page = await extension.context.newPage();
      await page.goto(`${server.origin}/${ARTICLES.long}`);
      await activate(extension.worker, await activeTabId(extension.worker, page.url()));
      const content = await findContentMainContext(page);

      await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");

      await expect(page.locator("#long-p1 .ilmt-tr")).toHaveCount(1);
      await expect(page.locator("#long-p60 .ilmt-tr")).toHaveCount(0);
      const initialCount = await page.locator(".ilmt-tr").count();
      expect(initialCount).toBeGreaterThan(0);
      expect(initialCount).toBeLessThan(30);

      await page.locator("#long-p30").scrollIntoViewIfNeeded();
      await expect(page.locator("#long-p30 .ilmt-tr")).toHaveCount(1);
      await expect(page.locator("#long-p60 .ilmt-tr")).toHaveCount(0);

      // Scrolling back must not re-request or duplicate the first paragraph.
      await page.locator("#long-p1").scrollIntoViewIfNeeded();
      await expect(page.locator("#long-p1 .ilmt-tr")).toHaveCount(1);

      await evaluateInContent(content, "globalThis.__ilmtMain.restore()");
      await expect(page.locator(".ilmt-tr")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });
});
