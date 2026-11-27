import type { GlossaryNote } from "../shared/types";

/**
 * Persistent translation cache backed by IndexedDB.
 *
 * A cache key hashes every input that can change a translation, so switching
 * provider, model or prompt version can never surface a stale result. Entries
 * expire after 30 days, and the least-recently-used ones are evicted once the
 * entry or byte cap is exceeded.
 */

const DEFAULT_DB_NAME = "ilmt-cache";
const STORE_NAME = "translations";
const DB_VERSION = 1;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

const encoder = new TextEncoder();

function textBytes(text: string): number {
  return encoder.encode(text).byteLength;
}

export interface CachedTranslation {
  text: string;
  glossary: GlossaryNote[];
}

function recordBytes(record: Pick<CacheRecord, "text" | "glossary">): number {
  return textBytes(record.text) + textBytes(JSON.stringify(record.glossary ?? []));
}

/**
 * Bytes recorded when the entry was written. Legacy records predate the
 * `bytes` field, so fall back to recomputing from their text.
 */
function storedRecordBytes(record: CacheRecord): number {
  return typeof record.bytes === "number" && Number.isFinite(record.bytes) && record.bytes >= 0
    ? record.bytes
    : recordBytes(record);
}

export interface CacheKeyInput {
  sourceText: string;
  targetLang: string;
  providerConfigId: string;
  modelId: string;
  promptVersion: string;
}

export interface TranslationCacheOptions {
  /** Entries allowed before least-recently-used eviction, at least 1. */
  maxEntries?: number;
  /** UTF-8 bytes of stored text allowed before LRU eviction; defaults to 50 MB. */
  maxBytes?: number;
}

interface CacheRecord {
  key: string;
  text: string;
  glossary?: GlossaryNote[];
  modelId: string;
  createdAt: number;
  lastUsedAt: number;
  /** Stored byte size; absent on legacy records written before this field. */
  bytes?: number;
}

/** One write for `putMany`; `meta.modelId` travels with the entry for stats. */
export interface CachePutEntry {
  key: string;
  value: CachedTranslation;
  meta: { modelId: string };
}

/** NUL cannot appear in the joined fields, so the digest stays unambiguous. */
export async function buildCacheKey(input: CacheKeyInput): Promise<string> {
  const joined = [
    input.sourceText,
    input.targetLang,
    input.providerConfigId,
    input.modelId,
    input.promptVersion,
  ].join("\u0000");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    let result!: T;

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));

    run(tx.objectStore(STORE_NAME)).then(
      value => {
        result = value;
      },
      error => {
        tx.abort();
        reject(error);
      },
    );
  });
}

export class TranslationCache {
  private readonly dbName: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private dbPromise: Promise<IDBDatabase> | undefined;

  /**
   * In-memory LRU index: key → stored bytes, iteration order LRU front → MRU
   * back. Hydrated lazily from IndexedDB the first time a write needs it, so
   * the O(n) `getAll` scan happens once per page/session instead of once per
   * put. `null` means "not hydrated".
   */
  private index: Map<string, number> | null = null;
  private totalBytes = 0;
  private indexPromise: Promise<void> | undefined;
  /** Serializes writes (and clears) so the index cannot drift under itself. */
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * Logical clock for `lastUsedAt`. Real time alone can tie two accesses in
   * the same millisecond, which would make LRU eviction pick arbitrarily.
   */
  private lastUse = 0;

  constructor(dbName: string = DEFAULT_DB_NAME, options: TranslationCacheOptions = {}) {
    this.dbName = dbName;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  }

  async get(key: string): Promise<CachedTranslation | undefined> {
    // Always read through to IndexedDB: another context may have cleared or
    // expired the entry, and the in-memory index must never serve stale text.
    const db = await this.open();
    const record = await withStore(db, "readonly", store => request<CacheRecord | undefined>(store.get(key)));
    if (!record) {
      this.removeFromIndex(key);
      return undefined;
    }

    if (Date.now() - record.createdAt >= TTL_MS) {
      await withStore(db, "readwrite", store => request(store.delete(key)));
      this.removeFromIndex(key);
      return undefined;
    }

    record.lastUsedAt = this.nextLastUse();
    record.bytes = storedRecordBytes(record);
    await withStore(db, "readwrite", store => request(store.put(record)));
    this.touchIndex(key, record.bytes);
    return { text: record.text, glossary: record.glossary ?? [] };
  }

  async put(key: string, value: CachedTranslation, meta: { modelId: string }): Promise<void> {
    return this.putMany([{ key, value, meta }]);
  }

  /**
   * Write a whole batch in one transaction. The caller-facing promise reflects
   * its own outcome, while `writeChain` stays resolved so one failed batch
   * cannot poison later writes.
   */
  async putMany(entries: CachePutEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const task = this.writeChain.then(() => this.writeMany(entries));
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async clear(): Promise<void> {
    const task = this.writeChain.then(async () => {
      const db = await this.open();
      await withStore(db, "readwrite", store => request(store.clear()));
      this.index = new Map();
      this.totalBytes = 0;
      this.indexPromise = undefined;
    });
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const db = await this.open();
    const records = await withStore(db, "readonly", store => request<CacheRecord[]>(store.getAll()));
    const bytes = records.reduce((total, record) => total + storedRecordBytes(record), 0);
    return { count: records.length, bytes };
  }

  /**
   * Test-only seam: backdate an entry without waiting for the wall clock.
   * Production code must never call this.
   */
  async _setCreatedAtForTest(key: string, createdAt: number): Promise<void> {
    const db = await this.open();
    const record = await withStore(db, "readonly", store => request<CacheRecord | undefined>(store.get(key)));
    if (!record) return;
    record.createdAt = createdAt;
    await withStore(db, "readwrite", store => request(store.put(record)));
  }

  private async writeMany(entries: CachePutEntry[]): Promise<void> {
    const db = await this.open();
    await this.ensureIndex(db);
    const index = this.index;
    if (!index) throw new Error("translation cache index unavailable");

    const now = Date.now();
    try {
      await withStore(db, "readwrite", store => {
        for (const entry of entries) {
          const record: CacheRecord = {
            key: entry.key,
            text: entry.value.text,
            glossary: entry.value.glossary ?? [],
            modelId: entry.meta.modelId,
            createdAt: now,
            lastUsedAt: this.nextLastUse(),
          };
          const bytes = recordBytes(record);
          record.bytes = bytes;

          // Overwriting (including a duplicate key inside this same batch)
          // must first retire the previous size, or `totalBytes` drifts.
          const previous = index.get(entry.key);
          if (previous !== undefined) {
            this.totalBytes -= previous;
            index.delete(entry.key);
          }
          store.put(record);
          index.set(entry.key, bytes);
          this.totalBytes += bytes;
        }

        // Map iteration order is insertion order, so the front is always the
        // least-recently-used key. Eviction is O(1) per key.
        while (
          index.size > 0 &&
          (index.size > this.maxEntries || this.totalBytes > this.maxBytes)
        ) {
          const oldest = index.keys().next();
          if (oldest.done) break;
          const key = oldest.value;
          const bytes = index.get(key) ?? 0;
          index.delete(key);
          this.totalBytes -= bytes;
          store.delete(key);
        }
        return Promise.resolve();
      });
    } catch (error) {
      // The transaction rolled back; the in-memory mirror is now untrustworthy.
      this.invalidateIndex();
      throw error;
    }
  }

  /**
   * Hydrate the index once. Existing records are ordered by `lastUsedAt ASC,
   * key ASC` so the Map's insertion order is a valid LRU order. Concurrent
   * callers share one `getAll` scan.
   */
  private ensureIndex(db: IDBDatabase): Promise<void> {
    if (this.index) return Promise.resolve();
    if (this.indexPromise) return this.indexPromise;

    let promise: Promise<void>;
    promise = this.hydrateIndex(db).finally(() => {
      if (this.indexPromise === promise) this.indexPromise = undefined;
    });
    this.indexPromise = promise;
    return promise;
  }

  private async hydrateIndex(db: IDBDatabase): Promise<void> {
    const records = await withStore(db, "readonly", store => request<CacheRecord[]>(store.getAll()));
    records.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.key.localeCompare(b.key));

    const index = new Map<string, number>();
    let total = 0;
    for (const record of records) {
      const bytes = storedRecordBytes(record);
      index.set(record.key, bytes);
      total += bytes;
    }
    this.index = index;
    this.totalBytes = total;
  }

  private touchIndex(key: string, bytes: number): void {
    if (!this.index) return;
    const previous = this.index.get(key);
    this.index.delete(key);
    this.index.set(key, bytes);
    this.totalBytes += previous === undefined ? bytes : bytes - previous;
  }

  private removeFromIndex(key: string): void {
    if (!this.index) return;
    const bytes = this.index.get(key);
    if (bytes === undefined) return;
    this.index.delete(key);
    this.totalBytes -= bytes;
  }

  private invalidateIndex(): void {
    this.index = null;
    this.totalBytes = 0;
    this.indexPromise = undefined;
  }

  private nextLastUse(): number {
    this.lastUse = Math.max(Date.now(), this.lastUse + 1);
    return this.lastUse;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    });
    this.dbPromise = promise;

    promise.then(
      db => {
        // `deleteDatabase` (tests, "clear cache" in another tab) emits this;
        // without closing, the delete would stay blocked forever. The index
        // belongs to the closed connection and must be recomputed next time.
        db.onversionchange = () => {
          this.invalidateIndex();
          db.close();
          if (this.dbPromise === promise) this.dbPromise = undefined;
        };
      },
      () => {
        if (this.dbPromise === promise) this.dbPromise = undefined;
      },
    );

    return promise;
  }
}
