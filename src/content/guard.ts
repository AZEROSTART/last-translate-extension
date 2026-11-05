/**
 * document_start content-script guard.
 *
 * This file is a classic script entry and must stay free of static imports:
 * the main bundle is a separate `content_main.js` entry, fetched on the first
 * trigger (activate, ask-selection, a qualifying text selection, or an
 * auto-current-site rule) and executed exactly once per document. The guard
 * stays intentionally small: it only decides *when* to load the bundle and
 * replays the trigger that caused the load.
 */

type MainModule = { runContentMain(): void };
type Loader = (url: string) => Promise<MainModule>;

interface MainHook {
  askSelection?(): void;
  translatePage?(): Promise<void>;
  showSelectionBubble?(): void;
}

interface GuardGlobal {
  __ilmtGuard?: boolean;
  /** Set when the loader was triggered by an `activate` message. */
  __ilmtPendingActivate?: boolean;
  /** Set when the first trigger was ask-selection, before the main bundle loads. */
  __ilmtPendingAskSelection?: boolean;
  /** Set when a mouseup selection should open the bubble after loading. */
  __ilmtPendingBubble?: boolean;
  /** Test/host seam; production falls back to the native dynamic import. */
  __ilmtImport?: Loader;
  __ilmtMain?: MainHook;
  /** Test seam: lets a fresh module instance drop the previous guard's listener. */
  __ilmtMouseupHandler?: (event: MouseEvent) => void;
}

const scope = globalThis as typeof globalThis & GuardGlobal;
const MIN_SELECTION_LENGTH = 2;
let loadPromise: Promise<void> | null = null;

function dispatchPending(): void {
  const main = scope.__ilmtMain;
  if (scope.__ilmtPendingAskSelection) {
    scope.__ilmtPendingAskSelection = false;
    call(() => main?.askSelection?.());
  }
  if (scope.__ilmtPendingActivate) {
    scope.__ilmtPendingActivate = false;
    call(() => void main?.translatePage?.());
  }
  if (scope.__ilmtPendingBubble) {
    scope.__ilmtPendingBubble = false;
    call(() => main?.showSelectionBubble?.());
  }
}

function call(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error("[ilmt] failed to dispatch pending action", error);
  }
}

function startMain(): Promise<void> {
  const load: Loader =
    scope.__ilmtImport ?? ((url: string) => import(/* @vite-ignore */ url));
  return load(chrome.runtime.getURL("content_main.js")).then((mod) => {
    mod.runContentMain();
  });
}

/** Load the main bundle at most once, then replay whichever trigger asked for it. */
function ensureMain(): Promise<void> {
  if (!loadPromise) {
    scope.__ilmtGuard = true;
    loadPromise = startMain().catch((error) => {
      console.error("[ilmt] failed to start content main", error);
      loadPromise = null;
      scope.__ilmtGuard = false;
    });
  }
  return loadPromise.then(dispatchPending);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (scope.__ilmtGuard) return;
  if (message?.type !== "activate" && message?.type !== "ask-selection") return;
  if (sender?.id !== chrome.runtime.id) return;

  if (message.type === "ask-selection") scope.__ilmtPendingAskSelection = true;
  else scope.__ilmtPendingActivate = true;
  void ensureMain();
});

/** No main bundle yet: a real, non-editable selection loads it so the bubble can show. */
function handleGuardMouseUp(): void {
  if (scope.__ilmtGuard) return;
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (text.length < MIN_SELECTION_LENGTH || !selection) return;

  const node = selection.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  if (el?.closest("input, textarea, [contenteditable]")) return;

  scope.__ilmtPendingBubble = true;
  void ensureMain();
}

function bindMouseUp(): void {
  const previous = scope.__ilmtMouseupHandler;
  if (previous) document.removeEventListener("mouseup", previous);
  document.addEventListener("mouseup", handleGuardMouseUp);
  scope.__ilmtMouseupHandler = handleGuardMouseUp;
}

/** Spec §8.1 `auto-current-site`: translate after load unless the host is opted out. */
function startAuto(): void {
  try {
    const stored = chrome.storage.local.get("settings");
    void Promise.resolve(stored)
      .then((items) => {
        const settings = (items as { settings?: Record<string, unknown> })?.settings;
        if (settings?.triggerMode !== "auto-current-site") return;
        const rules = settings.siteRules as Record<string, string> | undefined;
        if (rules?.[location.hostname] === "never") return;
        if (document.readyState === "loading") {
          document.addEventListener(
            "DOMContentLoaded",
            () => {
              scope.__ilmtPendingActivate = true;
              void ensureMain();
            },
            { once: true },
          );
        } else {
          scope.__ilmtPendingActivate = true;
          void ensureMain();
        }
      })
      .catch(() => {
        // Unreadable storage: behave like triggerMode "shortcut".
      });
  } catch {
    // No storage surface (tests / restricted pages): shortcut-only.
  }
}

bindMouseUp();
startAuto();

// Module marker for TypeScript; the emitted guard stays a classic script.
export {};
