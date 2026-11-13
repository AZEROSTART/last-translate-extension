/**
 * Shared Playwright harness for the extension specs: one throwaway profile per
 * test, a seeded mock provider, and just enough Chrome plumbing to drive the
 * content script. Nothing here imports `test`, so the helpers stay usable from
 * any spec (learning, settings, ...) without pulling in the runner.
 */

import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const EXTENSION_PATH = resolve("dist");
export const ARTICLE = "article.html";
export const TEN_MINUTES = 10 * 60 * 1000;

export interface Extension {
  context: BrowserContext;
  worker: Worker;
  userDataDir: string;
}

export async function launchExtension(): Promise<Extension> {
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

export async function seedSettings(worker: Worker, baseURL: string): Promise<void> {
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
        mascot: { mode: "rotate", enabledIds: ["gopher-hole"], animations: true },
        reviewAnswerLang: "",
      },
    });
    await chrome.storage.local.remove("learning");
  }, baseURL);
}

export async function activeTabId(worker: Worker, pageUrl: string): Promise<number> {
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    return tab?.id;
  }, pageUrl);

  if (tabId === undefined) throw new Error(`no extension tab found for ${pageUrl}`);
  return tabId;
}

export async function activate(worker: Worker, tabId: number): Promise<void> {
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "activate" }), tabId);
}

/** Find the content script's isolated world via CDP, like `translate.spec.ts`. */
export async function findContentMainContext(
  page: Page,
): Promise<{ session: CDPSession; contextId: number }> {
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

export async function evaluateInContent<T>(
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

export interface StoredWord {
  id: string;
  termLang: string;
  surface: string;
  box: number;
  dueAt: number | null;
  mascotId?: string;
  glosses: Array<{ lang: string; meaning: string }>;
}

export async function readWords(worker: Worker): Promise<StoredWord[]> {
  return worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get("learning")).learning as
      | { words?: StoredWord[] }
      | undefined;
    return stored?.words ?? [];
  });
}
