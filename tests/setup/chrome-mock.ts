/**
 * In-memory `chrome.storage.local` for Vitest. Values are cloned on the way
 * in and out so callers cannot mutate the backing store directly, mirroring
 * Chrome's serialization behavior.
 *
 * Also provides the minimal `chrome.runtime` surface content scripts touch:
 * the extension id, `getURL`, and an observable `onMessage` event.
 */

import { vi } from "vitest";

type StorageItems = Record<string, unknown>;
type StorageGetKeys = string | string[] | StorageItems | null | undefined;
type Callback<T> = (value: T) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createStorageArea() {
  const store = new Map<string, unknown>();

  function get(keys?: StorageGetKeys, callback?: Callback<StorageItems>): Promise<StorageItems> {
    let result: StorageItems;

    if (keys === null || keys === undefined) {
      result = Object.fromEntries([...store].map(([key, value]) => [key, clone(value)]));
    } else if (typeof keys === "string") {
      result = store.has(keys) ? { [keys]: clone(store.get(keys)) } : {};
    } else if (Array.isArray(keys)) {
      result = Object.fromEntries(
        keys.filter((key) => store.has(key)).map((key) => [key, clone(store.get(key))]),
      );
    } else {
      result = Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          store.has(key) ? clone(store.get(key)) : clone(fallback),
        ]),
      );
    }

    const promise = Promise.resolve(result);
    if (callback) void promise.then(callback);
    return promise;
  }

  function set(items: StorageItems, callback?: Callback<void>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      store.set(key, clone(value));
    }

    const promise = Promise.resolve();
    if (callback) void promise.then(callback);
    return promise;
  }

  function remove(keys: string | string[], callback?: Callback<void>): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) store.delete(key);

    const promise = Promise.resolve();
    if (callback) void promise.then(callback);
    return promise;
  }

  function clear(callback?: Callback<void>): Promise<void> {
    store.clear();

    const promise = Promise.resolve();
    if (callback) void promise.then(callback);
    return promise;
  }

  return { get, set, remove, clear };
}

const chromeMock = {
  storage: {
    local: createStorageArea(),
  },
  runtime: {
    id: "test-extension-id",
    getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
    onMessage: {
      addListener: vi.fn(),
    },
  },
} as unknown as typeof chrome;

(globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = chromeMock;

export {};
