import "fake-indexeddb/auto";
import { it, expect, beforeEach } from "vitest";
import { TranslationCache, buildCacheKey } from "../../src/background/cache";

const key = (over = {}) => buildCacheKey({ sourceText: "hello", targetLang: "zh-CN", providerConfigId: "a", modelId: "m", promptVersion: "v1", ...over });

beforeEach(async () => { await indexedDB.deleteDatabase("ilmt-cache"); });

it("is stable and sensitive to every field", async () => {
  expect(await key()).toBe(await key());
  expect(await key({ sourceText: "other" })).not.toBe(await key());
  expect(await key({ targetLang: "ja" })).not.toBe(await key());
  expect(await key({ modelId: "other" })).not.toBe(await key());
  expect(await key({ providerConfigId: "b" })).not.toBe(await key());
  expect(await key({ promptVersion: "v2" })).not.toBe(await key());
});

it("round-trips values", async () => {
  const c = new TranslationCache("ilmt-cache");
  await c.put(await key(), "你好", { modelId: "m" });
  expect(await c.get(await key())).toBe("你好");
});

it("expires entries older than 30 days", async () => {
  const c = new TranslationCache("ilmt-cache");
  const k = await key();
  await c.put(k, "旧", { modelId: "m" });
  await c._setCreatedAtForTest(k, Date.now() - 31 * 24 * 3600 * 1000);
  expect(await c.get(k)).toBeUndefined();
});

it("evicts least-recently-used beyond the entry cap", async () => {
  const c = new TranslationCache("ilmt-cache", { maxEntries: 2 });
  const k1 = await key({ sourceText: "a" }), k2 = await key({ sourceText: "b" }), k3 = await key({ sourceText: "c" });
  await c.put(k1, "1", { modelId: "m" }); await c.put(k2, "2", { modelId: "m" });
  await c.get(k2);
  await c.put(k3, "3", { modelId: "m" });
  expect(await c.get(k1)).toBeUndefined();
  expect(await c.get(k2)).toBe("2");
  expect(await c.get(k3)).toBe("3");
});

it("clears entries and reports count and byte size", async () => {
  const c = new TranslationCache("ilmt-cache");
  await c.put(await key({ sourceText: "a" }), "你好", { modelId: "m" });
  await c.put(await key({ sourceText: "b" }), "hello", { modelId: "m" });
  expect(await c.stats()).toEqual({ count: 2, bytes: 11 });
  await c.clear();
  expect(await c.stats()).toEqual({ count: 0, bytes: 0 });
});
