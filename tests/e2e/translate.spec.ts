/**
 * End-to-end coverage for the loaded MV3 extension: translate + restore on an
 * English article, the command/activate path, and the zero-request language
 * skip on an already-Chinese page.
 *
 * Each test owns its Chromium profile, fixture/mock server and page, and
 * `afterEach` closes both so a failure cannot leak a browser.
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
  const channel = process.env.ILMT_E2E_CHANNEL;

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      // MV3 extensions need a persistent context. Headed also matches the
      // spec's note that old headless cannot load extensions; new headless
      // would need `channel: "chromium"`.
      headless: false,
      ...(channel ? { channel } : {}),
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

  test.afterEach(async () => {
    await extension?.context.close();
    await server?.close();
    if (extension) await rm(extension.userDataDir, { recursive: true, force: true });
    extension = undefined;
    server = undefined;
  });

  test("translates an English article and restores it", async () => {
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
  });

  test("translates when the command/activate message is delivered again", async () => {
    server = await startMockServer();
    extension = await launchExtension();
    await seedSettings(extension.worker, server.origin);

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/${ARTICLES.english}`);
    const tabId = await activeTabId(extension.worker, page.url());

    // First activate is consumed by the guard and loads content_main.
    await activate(extension.worker, tabId);
    await findContentMainContext(page);

    // The shortcut's next press reaches the main listener. Do not call the
    // exposed test hook: this must translate from the message alone.
    await activate(extension.worker, tabId);
    await expect(page.locator(".ilmt-tr")).toHaveCount(10);
    await expect(page.locator(".ilmt-tr").first()).toContainText("译文");
  });

  test("sends no provider requests on an already-Chinese page", async () => {
    server = await startMockServer();
    extension = await launchExtension();
    await seedSettings(extension.worker, server.origin);

    const page = await extension.context.newPage();
    await page.goto(`${server.origin}/${ARTICLES.chinese}`);
    await activate(extension.worker, await activeTabId(extension.worker, page.url()));
    const content = await findContentMainContext(page);

    await evaluateInContent(content, "globalThis.__ilmtMain.translatePage()");
    await page.waitForTimeout(500);

    expect(server.requests).toHaveLength(0);
    await expect(page.locator(".ilmt-tr")).toHaveCount(0);
  });
});
