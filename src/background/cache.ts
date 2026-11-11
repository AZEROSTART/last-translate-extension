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
    const db = await this.open();
    const record = await withStore(db, "readonly", store => request<CacheRecord | undefined>(store.get(key)));
    if (!record) return undefined;

    if (Date.now() - record.createdAt >= TTL_MS) {
      await withStore(db, "readwrite", store => request(store.delete(key)));
      return undefined;
    }

    record.lastUsedAt = this.nextLastUse();
    await withStore(db, "readwrite", store => request(store.put(record)));
    return { text: record.text, glossary: record.glossary ?? [] };
  }

  async put(key: string, value: CachedTranslation, meta: { modelId: string }): Promise<void> {
    const now = Date.now();
    const record: CacheRecord = {
      key,
      text: value.text,
      glossary: value.glossary ?? [],
      modelId: meta.modelId,
      createdAt: now,
      lastUsedAt: this.nextLastUse(),
    };

    const db = await this.open();
    await withStore(db, "readwrite", store => request(store.put(record)));

    const records = await withStore(db, "readonly", store => request<CacheRecord[]>(store.getAll()));
    let remainingBytes = records.reduce((total, entry) => total + recordBytes(entry), 0);
    if (records.length <= this.maxEntries && remainingBytes <= this.maxBytes) return;

    records.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.key.localeCompare(b.key));
    const doomed: string[] = [];
    let remainingCount = records.length;
    for (const entry of records) {
      if (remainingCount <= this.maxEntries && remainingBytes <= this.maxBytes) break;
      doomed.push(entry.key);
      remainingCount--;
      remainingBytes -= recordBytes(entry);
    }

    await withStore(db, "readwrite", store => {
      for (const doomedKey of doomed) store.delete(doomedKey);
      return Promise.resolve();
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    await withStore(db, "readwrite", store => request(store.clear()));
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const db = await this.open();
    const records = await withStore(db, "readonly", store => request<CacheRecord[]>(store.getAll()));
    const bytes = records.reduce((total, record) => total + recordBytes(record), 0);
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
        // without closing, the delete would stay blocked forever.
        db.onversionchange = () => {
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
