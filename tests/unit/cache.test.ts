import "fake-indexeddb/auto";
import { it, expect, beforeEach, vi } from "vitest";
import { TranslationCache, buildCacheKey } from "../../src/background/cache";

const key = (over = {}) => buildCacheKey({ sourceText: "hello", targetLang: "zh-CN", providerConfigId: "a", modelId: "m", promptVersion: "v1", ...over });

beforeEach(async () => { await indexedDB.deleteDatabase("ilmt-cache"); });

async function putLegacyRecord(k: string, text: string, lastUsedAt = Date.now()): Promise<void> {
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
      createdAt: lastUsedAt,
      lastUsedAt,
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

async function storedKeys(): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("ilmt-cache", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const req = db.transaction("translations", "readonly").objectStore("translations").getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("getAllKeys failed"));
  });
  db.close();
  return keys.map(String);
}

function valueBytes(text: string): number {
  const encoder = new TextEncoder();
  return encoder.encode(text).byteLength + encoder.encode("[]").byteLength;
}

it("hydrates the LRU index once instead of scanning the store on every write", async () => {
  const c = new TranslationCache("ilmt-cache");
  const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  try {
    await c.put(await key({ sourceText: "a" }), { text: "1", glossary: [] }, { modelId: "m" });
    const afterHydration = getAll.mock.calls.length;
    expect(afterHydration).toBe(1);

    await c.put(await key({ sourceText: "b" }), { text: "2", glossary: [] }, { modelId: "m" });
    await c.putMany([
      { key: await key({ sourceText: "c" }), value: { text: "3", glossary: [] }, meta: { modelId: "m" } },
      { key: await key({ sourceText: "d" }), value: { text: "4", glossary: [] }, meta: { modelId: "m" } },
    ]);

    // No rescan after the initial hydration, even across a batch write.
    expect(getAll.mock.calls.length).toBe(afterHydration);
  } finally {
    getAll.mockRestore();
  }
});

it("overwrites duplicate keys in one batch without drifting the byte total", async () => {
  // "a" + "[]" = 3 bytes and "bb" + "[]" = 4 bytes, so the final contents fit
  // in 8 bytes. A double-counted overwrite would evict k1.
  const c = new TranslationCache("ilmt-cache", { maxEntries: 10, maxBytes: 8 });
  const k1 = await key({ sourceText: "a" });
  const k2 = await key({ sourceText: "b" });

  await c.putMany([
    { key: k1, value: { text: "aaaa", glossary: [] }, meta: { modelId: "m" } },
    { key: k1, value: { text: "a", glossary: [] }, meta: { modelId: "m" } },
    { key: k2, value: { text: "bb", glossary: [] }, meta: { modelId: "m" } },
  ]);

  expect(await c.get(k1)).toEqual({ text: "a", glossary: [] });
  expect(await c.get(k2)).toEqual({ text: "bb", glossary: [] });
});

it("evicts the LRU front across putMany batches", async () => {
  const c = new TranslationCache("ilmt-cache", { maxEntries: 2 });
  const k1 = await key({ sourceText: "a" });
  const k2 = await key({ sourceText: "b" });
  const k3 = await key({ sourceText: "c" });
  const k4 = await key({ sourceText: "d" });

  await c.putMany([
    { key: k1, value: { text: "1", glossary: [] }, meta: { modelId: "m" } },
    { key: k2, value: { text: "2", glossary: [] }, meta: { modelId: "m" } },
  ]);
  await c.get(k1); // k1 becomes most-recently used: order is k2, k1.
  await c.putMany([{ key: k3, value: { text: "3", glossary: [] }, meta: { modelId: "m" } }]);
  expect(await c.get(k2)).toBeUndefined();

  await c.putMany([{ key: k4, value: { text: "4", glossary: [] }, meta: { modelId: "m" } }]);
  expect(await c.get(k1)).toBeUndefined();
  expect(await c.get(k3)).toEqual({ text: "3", glossary: [] });
  expect(await c.get(k4)).toEqual({ text: "4", glossary: [] });
});

it("evicts the LRU front when one putMany batch exceeds the byte cap", async () => {
  // Every entry is 3 text bytes + "[]" = 5 bytes; a 9-byte cap keeps only the
  // last one after evicting the two oldest.
  const c = new TranslationCache("ilmt-cache", { maxEntries: 10, maxBytes: 9 });
  const k1 = await key({ sourceText: "a" });
  const k2 = await key({ sourceText: "b" });
  const k3 = await key({ sourceText: "c" });

  await c.putMany([
    { key: k1, value: { text: "111", glossary: [] }, meta: { modelId: "m" } },
    { key: k2, value: { text: "222", glossary: [] }, meta: { modelId: "m" } },
    { key: k3, value: { text: "333", glossary: [] }, meta: { modelId: "m" } },
  ]);

  expect(await c.get(k1)).toBeUndefined();
  expect(await c.get(k2)).toBeUndefined();
  expect(await c.get(k3)).toEqual({ text: "333", glossary: [] });
});

it("re-hydrates LRU order and byte sizes from existing records, including legacy rows", async () => {
  const k1 = await key({ sourceText: "legacy-one" });
  const k2 = await key({ sourceText: "legacy-two" });
  // Legacy rows written before the `bytes` field existed.
  await putLegacyRecord(k1, "旧一", 1);
  await putLegacyRecord(k2, "旧二", 2);

  const k3 = await key({ sourceText: "new" });
  const first = new TranslationCache("ilmt-cache", { maxEntries: 2 });
  await first.putMany([
    { key: k3, value: { text: "新", glossary: [] }, meta: { modelId: "m" } },
  ]);

  // Hydration ordered k1 (oldest) before k2, so inserting k3 evicted k1.
  expect(await storedKeys()).toEqual(expect.arrayContaining([k2, k3]));
  expect(await storedKeys()).not.toContain(k1);
  expect(await first.stats()).toEqual({
    count: 2,
    bytes: valueBytes("旧二") + valueBytes("新"),
  });

  // A fresh instance must rebuild the same order from IndexedDB alone.
  const k4 = await key({ sourceText: "newer" });
  const second = new TranslationCache("ilmt-cache", { maxEntries: 2 });
  await second.putMany([
    { key: k4, value: { text: "更新", glossary: [] }, meta: { modelId: "m" } },
  ]);

  expect(await storedKeys()).toEqual(expect.arrayContaining([k3, k4]));
  expect(await storedKeys()).not.toContain(k2);
});
