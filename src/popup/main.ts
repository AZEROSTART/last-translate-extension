/**
 * Toolbar popup shell. All settings live in the popup; the same shell is used
 * for the `popup.html?mode=page` fallback. Opening it performs no network
 * request.
 */

import type { Settings } from "../shared/types";
import { getLearning } from "../shared/learning-storage";
import { dueCount } from "../shared/srs";
import { createSettingsView, type SettingsViewHandle } from "../settings/settings-view";
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
  view = await createSettingsView(scrollHost, { mode });
  void refreshReviewEntry();
  void noteHostHealth();
  resolveReady();
}

/**
 * Make a broken shortcut visible instead of silent: Chrome can leave a
 * suggested key unassigned, and some hosts (Orca's embedded browser) do not
 * inject content scripts at all. Both look exactly like "the feature vanished".
 */
async function noteHostHealth(): Promise<void> {
  if (mode !== "popup") return;
  const warning = await hostWarning();
  if (!warning) return;
  const node = el("p", "popup-host-warning", warning);
  node.setAttribute("role", "status");
  const header = root.querySelector(".popup-header");
  if (header) header.after(node);
  else root.prepend(node);
}

async function hostWarning(): Promise<string | null> {
  try {
    const commands = await chrome.commands?.getAll?.();
    const translate = commands?.find((command) => command.name === "translate-page");
    if (translate && !translate.shortcut) {
      return "翻译快捷键未绑定：在 chrome://extensions/shortcuts 给「翻译当前页面」设置 Alt+A。";
    }
  } catch {
    // Older hosts without the commands API: fall through to the page probe.
  }

  const send = chrome.tabs?.sendMessage;
  if (typeof send !== "function") return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    // The popup opened as a tab is not a page the content script can live in.
    if (tab?.url?.startsWith(chrome.runtime.getURL(""))) return null;
    if (tab?.id !== undefined) await send(tab.id, { type: "ilmt-probe" });
  } catch {
    return "当前页面没有注入翻译脚本：请在 Chrome 中打开网页，或刷新本页后重试。";
  }
  return null;
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
  const openSidepanel = el("button", "popup-open-sidepanel", "打开翻译侧栏");
  openSidepanel.type = "button";
  openSidepanel.addEventListener("click", openSidePanel);
  footer.append(openSidepanel, el("span", "popup-hint", "Alt+A 翻译 · Alt+Q 解释 · Alt+S 侧栏"));
  root.appendChild(footer);
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
