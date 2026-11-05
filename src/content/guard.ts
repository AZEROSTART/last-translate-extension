/**
 * document_start content-script guard.
 *
 * This file is a classic script entry and must stay free of static imports:
 * the main bundle is a separate `content_main.js` entry, fetched on the first
 * trusted "activate" message and executed exactly once per document.
 */

type MainModule = { runContentMain(): void };
type Loader = (url: string) => Promise<MainModule>;

interface GuardGlobal {
  __ilmtGuard?: boolean;
  /** Test/host seam; production falls back to the native dynamic import. */
  __ilmtImport?: Loader;
}

const scope = globalThis as typeof globalThis & GuardGlobal;

function startMain(): Promise<void> {
  const load: Loader =
    scope.__ilmtImport ?? ((url: string) => import(/* @vite-ignore */ url));
  return load(chrome.runtime.getURL("content_main.js")).then((mod) => mod.runContentMain());
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (scope.__ilmtGuard) return;
  if (message?.type !== "activate") return;
  if (sender?.id !== chrome.runtime.id) return;

  scope.__ilmtGuard = true;
  void startMain().catch((error) => {
    console.error("[ilmt] failed to start content main", error);
  });
});

// Module marker for TypeScript; the emitted guard stays a classic script.
export {};
