/**
 * Toolbar popup shell. All settings live in the popup; the same shell is used
 * for the `popup.html?mode=page` fallback. Opening it performs no network
 * request.
 */

import type { Settings } from "../shared/types";
import { getLearning } from "../shared/learning-storage";
import { dueCount } from "../shared/srs";
import { createSettingsView, type SettingsViewHandle } from "../settings/settings-view";
import {
  applyDocumentTheme,
  normalizeThemePreference,
  watchSystemTheme,
} from "../shared/theme";
import themeCss from "../styles/theme.css?inline";
import popupCss from "../styles/popup.css?inline";
import settingsCss from "../styles/settings.css?inline";

type Mode = "popup" | "page";

const scope = globalThis as typeof globalThis & {
  __ilmtPopup?: {
    ready: Promise<void>;
    get settings(): Settings | null;
  };
};

let started = false;
let view: SettingsViewHandle | null = null;
let mode: Mode = "popup";
let root: HTMLElement;
let scrollHost: HTMLElement;
let hintNode: HTMLElement | null = null;
let translateButton: HTMLButtonElement | null = null;
let activeTab: { id?: number; url?: string } | undefined;

/** Only a real web page has a hostname the site-rules UI can edit. */
export function extractHttpHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

/** The footer always tells the truth Chrome currently has, with stable fallbacks. */
export function formatShortcutHint(
  commands?: ReadonlyArray<{ name?: string; shortcut?: string }>,
): string {
  const shortcut = (name: string, fallback: string): string =>
    commands?.find((command) => command.name === name)?.shortcut || fallback;
  return `${shortcut("translate-page", "Alt+A")} 翻译 · ${shortcut("ask-selection", "Alt+Q")} 解释 · ${shortcut("toggle-side-panel", "Alt+S")} 侧栏`;
}

let resolveReady!: () => void;
const ready = new Promise<void>((resolve) => (resolveReady = resolve));
scope.__ilmtPopup = {
  ready,
  get settings() {
    return view?.settings ?? null;
  },
};

export function runPopup(): Promise<void> {
  if (started) return ready;
  started = true;
  void start();
  return ready;
}

async function start(): Promise<void> {
  mode = new URLSearchParams(location.search).get("mode") === "page" ? "page" : "popup";
  document.documentElement.dataset.theme = "quantum";
  if (mode === "page") document.body.classList.add("page-mode");
  buildShell();
  injectStyles();
  activeTab = mode === "popup" ? await queryActiveTab() : undefined;
  view = await createSettingsView(scrollHost, {
    mode,
    currentHost: extractHttpHost(activeTab?.url),
  });
  applyDocumentTheme(document, view?.settings?.theme ?? "system");
  listenForThemeChanges();
  watchSystemTheme(window, () => {
    applyDocumentTheme(document, view?.settings?.theme ?? "system");
  });
  void refreshReviewEntry();
  void noteHostHealth(activeTab);
  resolveReady();
}

/** Settings save in any context updates this popup's paper immediately. */
function listenForThemeChanges(): void {
  try {
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes.settings) return;
      const stored = changes.settings.newValue as { theme?: unknown } | undefined;
      applyDocumentTheme(document, normalizeThemePreference(stored?.theme));
    });
  } catch {
    // Older hosts without storage events keep the theme applied at startup.
  }
}

async function queryActiveTab(): Promise<{ id?: number; url?: string } | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}

/**
 * Make a broken shortcut visible instead of silent: Chrome can leave a
 * suggested key unassigned, and some hosts (Orca's embedded browser) do not
 * inject content scripts at all. Both look exactly like "the feature vanished".
 */
async function noteHostHealth(tab: { id?: number; url?: string } | undefined): Promise<void> {
  if (mode !== "popup") return;

  let shortcutWarning: string | null = null;
  try {
    const commands = await chrome.commands?.getAll?.();
    if (hintNode) hintNode.textContent = formatShortcutHint(commands);
    const translate = commands?.find((command) => command.name === "translate-page");
    if (!translate || !translate.shortcut) {
      shortcutWarning =
        "翻译快捷键未绑定：在 chrome://extensions/shortcuts 给「翻译当前页面」设置 Alt+A（macOS 为 ⌥A）。";
    }
  } catch {
    if (hintNode) hintNode.textContent = formatShortcutHint();
    // Older hosts without the commands API: fall through to the page probe.
  }

  let probeWarning: string | null = null;
  const send = chrome.tabs?.sendMessage;
  const extensionUrl = chrome.runtime.getURL("");
  const canProbe =
    typeof send === "function" &&
    tab?.id !== undefined &&
    !(tab.url ?? "").startsWith(extensionUrl);
  if (canProbe) {
    try {
      const response = (await send(tab!.id!, { type: "ilmt-probe" })) as
        | { ok?: boolean; active?: boolean }
        | undefined;
      if (translateButton) {
        const active = Boolean(response?.active);
        translateButton.hidden = false;
        translateButton.disabled = false;
        translateButton.dataset.active = active ? "1" : "0";
        translateButton.textContent = active ? "还原当前页" : "翻译当前页";
      }
    } catch {
      if (translateButton) translateButton.hidden = true;
      probeWarning = "当前页面没有注入翻译脚本：请在 Chrome 中打开网页，或刷新本页后重试。";
    }
  }

  const warning = shortcutWarning ?? probeWarning;
  if (!warning) return;
  const node = el("p", "popup-host-warning", warning);
  node.setAttribute("role", "status");
  const header = root.querySelector(".popup-header");
  if (header) header.after(node);
  else root.prepend(node);
}

/** Show "待复习 N · 打开复习" only when something is actually due. */
async function refreshReviewEntry(): Promise<void> {
  let due = 0;
  try {
    due = dueCount((await getLearning()).words, Date.now());
  } catch {
    return;
  }
  if (due <= 0) return;

  const entry = el("button", "popup-review-entry", `待复习 ${due} · 打开复习`);
  entry.type = "button";
  entry.addEventListener("click", openReview);
  const header = root.querySelector(".popup-header");
  if (header) header.after(entry);
  else root.insertBefore(entry, scrollHost);
}

/** Mark the panel to open on the review view, then open it in this gesture. */
function openReview(): void {
  try {
    void chrome.storage.session?.set({ reviewPending: true });
  } catch {
    // Older Chrome without storage.session: the panel just opens on chat.
  }

  const close = (): void => {
    if (mode === "popup") window.close();
  };
  try {
    const windowId = chrome.windows?.WINDOW_ID_CURRENT ?? -2;
    void chrome.sidePanel
      .open({ windowId })
      .then(close)
      .catch(() => openSidePanelForActiveTab(close));
  } catch {
    openSidePanelForActiveTab(close);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function injectStyles(): void {
  if (document.querySelector("style[data-ilmt-popup]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-ilmt-popup", "");
  style.textContent = themeCss + popupCss + settingsCss;
  (document.head ?? document.documentElement).appendChild(style);
}

function buildShell(): void {
  root = document.getElementById("root") ?? document.body;
  root.replaceChildren();

  // Cropped from the design reference; decorative only, so screen readers skip it.
  const hero = el("div", "popup-hero");
  hero.setAttribute("aria-hidden", "true");
  root.appendChild(hero);

  const header = el("header", "popup-header");
  header.append(el("span", "popup-logo"), el("h1", "popup-title", "翻译设置"));
  root.appendChild(header);

  scrollHost = el("div", "popup-scroll");
  root.appendChild(scrollHost);

  const footer = el("footer", "popup-footer");
  const actions = el("div", "popup-actions");
  translateButton = el("button", "popup-translate-btn", "翻译当前页");
  translateButton.type = "button";
  translateButton.hidden = true;
  translateButton.addEventListener("click", () => void translateCurrentPage());
  const openSidepanel = el("button", "popup-open-sidepanel", "打开翻译侧栏");
  openSidepanel.type = "button";
  openSidepanel.addEventListener("click", openSidePanel);
  actions.append(translateButton, openSidepanel);
  hintNode = el("span", "popup-hint", formatShortcutHint());
  footer.append(actions, hintNode);
  root.appendChild(footer);
}

/** One click on the primary control is exactly the keyboard path. */
async function translateCurrentPage(): Promise<void> {
  if (!translateButton || activeTab?.id === undefined) return;
  translateButton.disabled = true;
  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "activate" });
    if (mode === "popup") {
      window.close();
      return;
    }
    translateButton.disabled = false;
  } catch {
    translateButton.disabled = false;
  }
}

/**
 * Open the side panel inside the click gesture, preferring the current window.
 * `sidePanel.open` must run while the user gesture is live; the fallback query
 * therefore happens synchronously (no await before the first open attempt).
 */
function openSidePanel(): void {
  const close = (): void => {
    if (mode === "popup") window.close();
  };

  try {
    void chrome.sidePanel
      .open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
      .then(close)
      .catch(() => openSidePanelForActiveTab(close));
  } catch {
    openSidePanelForActiveTab(close);
  }
}

function openSidePanelForActiveTab(close: () => void): void {
  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (tab?.id === undefined) return;
      return chrome.sidePanel.open({ tabId: tab.id }).then(close);
    })
    .catch(() => {
      // 静默失败，不把 Chrome 内部错误显示给用户。
    });
}

// Auto-run on load.
void runPopup();
