import "fake-indexeddb/auto";
import { it, expect, beforeEach } from "vitest";
import { TranslationCache, buildCacheKey } from "../../src/background/cache";

const key = (over = {}) => buildCacheKey({ sourceText: "hello", targetLang: "zh-CN", providerConfigId: "a", modelId: "m", promptVersion: "v1", ...over });

beforeEach(async () => { await indexedDB.deleteDatabase("ilmt-cache"); });

async function putLegacyRecord(k: string, text: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("ilmt-cache", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("translations")) {
        req.result.createObjectStore("translations", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("translations", "readwrite");
    tx.objectStore("translations").put({
      key: k,
      text,
      modelId: "m",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("put failed"));
  });
  db.close();
}

it("is stable and sensitive to every field", async () => {
  expect(await key()).toBe(await key());
  expect(await key({ sourceText: "other" })).not.toBe(await key());
  expect(await key({ targetLang: "ja" })).not.toBe(await key());
  expect(await key({ modelId: "other" })).not.toBe(await key());
  expect(await key({ providerConfigId: "b" })).not.toBe(await key());
  expect(await key({ promptVersion: "v2" })).not.toBe(await key());
});

it("round-trips translation and glossary", async () => {
  const c = new TranslationCache("ilmt-cache");
  const value = {
    text: "你好",
    glossary: [{ surface: "hello", pos: "int.", meaning: "你好" }],
  };
  await c.put(await key(), value, { modelId: "m" });
  expect(await c.get(await key())).toEqual(value);
});

it("returns an empty glossary for a legacy record without one", async () => {
  const c = new TranslationCache("ilmt-cache");
  const k = await key();
  await putLegacyRecord(k, "旧");
  expect(await c.get(k)).toEqual({ text: "旧", glossary: [] });
});

it("expires entries older than 30 days", async () => {
  const c = new TranslationCache("ilmt-cache");
  const k = await key();
  await c.put(k, { text: "旧", glossary: [] }, { modelId: "m" });
  await c._setCreatedAtForTest(k, Date.now() - 31 * 24 * 3600 * 1000);
  expect(await c.get(k)).toBeUndefined();
});

it("evicts least-recently-used beyond the entry cap", async () => {
  const c = new TranslationCache("ilmt-cache", { maxEntries: 2 });
  const k1 = await key({ sourceText: "a" }), k2 = await key({ sourceText: "b" }), k3 = await key({ sourceText: "c" });
  await c.put(k1, { text: "1", glossary: [] }, { modelId: "m" });
  await c.put(k2, { text: "2", glossary: [] }, { modelId: "m" });
  await c.get(k2);
  await c.put(k3, { text: "3", glossary: [] }, { modelId: "m" });
  expect(await c.get(k1)).toBeUndefined();
  expect(await c.get(k2)).toEqual({ text: "2", glossary: [] });
  expect(await c.get(k3)).toEqual({ text: "3", glossary: [] });
});

it("evicts least-recently-used beyond the byte cap", async () => {
  const c = new TranslationCache("ilmt-cache", { maxEntries: 10, maxBytes: 12 });
  const k1 = await key({ sourceText: "a" }), k2 = await key({ sourceText: "b" }), k3 = await key({ sourceText: "c" });
  await c.put(k1, { text: "aaa", glossary: [] }, { modelId: "m" });
  await c.put(k2, { text: "bbb", glossary: [] }, { modelId: "m" });
  await c.put(k3, { text: "ccc", glossary: [] }, { modelId: "m" });
  expect(await c.get(k1)).toBeUndefined();
  expect(await c.get(k2)).toEqual({ text: "bbb", glossary: [] });
  expect(await c.get(k3)).toEqual({ text: "ccc", glossary: [] });
});

it("counts glossary JSON bytes toward the byte cap", async () => {
  const glossary = [{ surface: "hello", meaning: "你好" }];
  const encoder = new TextEncoder();
  const valueBytes =
    encoder.encode("你好").byteLength + encoder.encode(JSON.stringify(glossary)).byteLength;
  const c = new TranslationCache("ilmt-cache", { maxEntries: 10, maxBytes: valueBytes + 3 });
  const k1 = await key({ sourceText: "a" });
  const k2 = await key({ sourceText: "b" });

  await c.put(k1, { text: "你好", glossary }, { modelId: "m" });
  await c.put(k2, { text: "hi", glossary: [] }, { modelId: "m" });

  expect(await c.get(k1)).toBeUndefined();
  expect(await c.get(k2)).toEqual({ text: "hi", glossary: [] });
});

it("clears entries and reports count and byte size", async () => {
  const c = new TranslationCache("ilmt-cache");
  await c.put(await key({ sourceText: "a" }), { text: "你好", glossary: [] }, { modelId: "m" });
  await c.put(await key({ sourceText: "b" }), { text: "hello", glossary: [] }, { modelId: "m" });
  const encoder = new TextEncoder();
  const bytes =
    encoder.encode("你好").byteLength +
    encoder.encode("[]").byteLength +
    encoder.encode("hello").byteLength +
    encoder.encode("[]").byteLength;
  expect(await c.stats()).toEqual({ count: 2, bytes });
  await c.clear();
  expect(await c.stats()).toEqual({ count: 0, bytes: 0 });
});
