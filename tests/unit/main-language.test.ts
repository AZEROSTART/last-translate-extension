/**
 * Language-detection wiring: `main.ts` must pass a `chrome.i18n.detectLanguage`
 * adapter (callback or promise shape) to `collectParagraphs`, so already-target
 * paragraphs are skipped with the target language's prefix.
 */

import { it, expect, vi, beforeEach, afterEach } from "vitest";

function setTargetLang(targetLang: string): Promise<void> {
  return chrome.storage.local.set({ settings: { targetLang } });
}

function stubDetector(
  detect: (text: string) => { languages: Array<{ language: string; percentage: number }> },
): void {
  (chrome as any).i18n = {
    detectLanguage: vi.fn((text: string, callback: (result: unknown) => void) => {
      callback(detect(text));
    }),
  };
}

function cjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = "";
  await chrome.storage.local.clear();
  delete (globalThis as any).__ilmtTestPort;
});

afterEach(() => {
  const main = (globalThis as any).__ilmtMain;
  if (main && typeof main.restore === "function") main.restore();
  delete (globalThis as any).__ilmtTestPort;
  delete (globalThis as any).__ilmtMain;
  delete (chrome as any).i18n;
});

it("skips English paragraphs when the target language is English", async () => {
  await setTargetLang("en");
  stubDetector((text) => ({
    languages: [{ language: cjk(text) ? "zh" : "en", percentage: 100 }],
  }));
  document.body.innerHTML = `<p>This English paragraph needs no translation.</p>
    <p>这是一段需要翻译的中文内容。</p>`;

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((message) => message.type === "translate");
  expect(translate.items.map((item: any) => item.text)).toEqual(["这是一段需要翻译的中文内容。"]);
});

it("translates only the non-target half of a mixed page", async () => {
  await setTargetLang("zh-CN");
  stubDetector((text) => ({
    languages: [
      { language: cjk(text) ? "zh-Hans" : "en", percentage: 97 },
      { language: cjk(text) ? "en" : "zh", percentage: 2 },
    ],
  }));
  document.body.innerHTML = `<p>English paragraph on a mixed page.</p>
    <p>混合页面上的中文段落。</p>
    <p>Another English paragraph here.</p>`;

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((message) => message.type === "translate");
  expect(translate.items.map((item: any) => item.text)).toEqual([
    "English paragraph on a mixed page.",
    "Another English paragraph here.",
  ]);
});

it("does not skip a target-language paragraph below the skip ratio", async () => {
  await setTargetLang("zh-CN");
  stubDetector((text) => {
    if (!cjk(text)) return { languages: [{ language: "en", percentage: 100 }] };
    const share = text.includes("几乎") ? 90 : 70;
    return {
      languages: [
        { language: "zh-Hans", percentage: share },
        { language: "en", percentage: 100 - share },
      ],
    };
  });
  document.body.innerHTML = `<p>这是中英混合的段落 with plenty of English.</p>
    <p>这是几乎全中文的段落内容。</p>`;

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((message) => message.type === "translate");
  expect(translate.items.map((item: any) => item.text)).toEqual([
    "这是中英混合的段落 with plenty of English.",
  ]);
});

it("aggregates script variants before comparing the skip ratio", async () => {
  await setTargetLang("zh-CN");
  // Each variant is below 0.8, but together they are 0.85 of the paragraph.
  stubDetector(() => ({
    languages: [
      { language: "zh-Hans", percentage: 50 },
      { language: "zh-Hant", percentage: 35 },
      { language: "en", percentage: 15 },
    ],
  }));
  document.body.innerHTML = `<p>这是简繁混合的中文段落内容。</p>`;

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };
  await (globalThis as any).__ilmtMain.translatePage();

  expect(sent.find((message) => message.type === "translate")).toBeUndefined();
});

it("accepts the promise shape of chrome.i18n.detectLanguage", async () => {
  await setTargetLang("zh-CN");
  (chrome as any).i18n = {
    detectLanguage: vi.fn(async (text: string) => ({
      languages: [{ language: cjk(text) ? "zh" : "en", percentage: 100 }],
    })),
  };
  document.body.innerHTML = `<p>Only English should be translated.</p>
    <p>中文段落保持原样。</p>`;

  const { runContentMain } = await import("../../src/content/main");
  runContentMain();
  const sent: any[] = [];
  (globalThis as any).__ilmtTestPort = { send: (message: unknown) => sent.push(message) };
  await (globalThis as any).__ilmtMain.translatePage();

  const translate = sent.find((message) => message.type === "translate");
  expect(translate.items.map((item: any) => item.text)).toEqual([
    "Only English should be translated.",
  ]);
});
