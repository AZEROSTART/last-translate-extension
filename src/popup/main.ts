/**
 * Toolbar popup model-configuration UI. Vanilla DOM only — no framework, no
 * inline scripts.
 *
 * Opens with the DeepSeek form when no providers exist, otherwise loads the
 * active provider (or the first). Supports adding/selecting providers, type
 * switching, save, set-active, model discovery, and a connection test. API
 * keys stay in `chrome.storage.local`; only a mask is ever rendered.
 *
 * Opening the popup performs no network request — `listModels`/`complete` run
 * only when the user clicks 拉取模型 / 测试连接.
 */

import { getSettings, saveSettings, upsertProvider } from "../shared/storage";
import type { ErrorCode, ProviderConfig, ProviderKind, Settings } from "../shared/types";
import { complete, listModels } from "../providers";
import { DEEPSEEK_PRESET, PROVIDER_KIND_LABELS } from "../shared/providers";
import {
  applyProviderForm,
  errorLabel,
  maskKey,
  validateProvider,
  type ProviderFormState,
} from "../options/providers";
import { ProviderError } from "../shared/errors";
import themeCss from "../styles/theme.css?inline";
import cssText from "../styles/popup.css?inline";

const FIELD_ERROR_LABELS: Record<string, string> = {
  baseURL: "请填写接口地址",
  apiKey: "请填写 API Key",
  model: "请选择或填写模型",
};

const scope = globalThis as typeof globalThis & {
  __ilmtPopup?: {
    ready: Promise<void>;
    get settings(): Settings | null;
  };
};

// --- module state ---
let started = false;
let settings: Settings | null = null;
let current: ProviderConfig | null = null; // saved provider; null = new draft
let isNew = false;
let draft!: ProviderFormState; // new draft; kind defaults to deepseek

// --- DOM refs ---
let root: HTMLElement;
let providerSelect: HTMLSelectElement;
let addButton: HTMLButtonElement;
let formHost: HTMLElement;

let resolveReady!: () => void;
const ready = new Promise<void>((resolve) => (resolveReady = resolve));
scope.__ilmtPopup = {
  ready,
  get settings() {
    return settings;
  },
};

export function runPopup(): Promise<void> {
  if (started) return ready;
  started = true;
  void start();
  return ready;
}

async function start(): Promise<void> {
  document.documentElement.dataset.theme = "quantum";
  try {
    settings = await getSettings();
  } catch {
    settings = null;
  }
  buildShell();
  injectStyles();
  if (!settings) {
    formHost.replaceChildren(el("p", "popup-read-error", "读取设置失败，请重试。"));
    resolveReady();
    return;
  }
  if (settings.providers.length > 0) {
    current =
      settings.providers.find((p) => p.id === settings!.activeProviderId) ??
      settings.providers[0];
    isNew = false;
  } else {
    current = null;
    isNew = true;
    draft = newDeepSeekDraft();
  }
  render();
  resolveReady();
}

// --- DOM helpers ---

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

function field(labelText: string, input: HTMLElement): HTMLElement {
  const wrap = el("label", "popup-field");
  wrap.appendChild(el("span", "popup-field-label", labelText));
  wrap.appendChild(input);
  return wrap;
}

function newProviderId(): string {
  const cryptoApi = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Classify a caught provider error. `instanceof` is not reliable here because
 * the module registry is reset per test, so the popup and its callers can hold
 * different copies of `ProviderError`. Reading the normalized `code` field is
 * key-free and never touches the raw message.
 */
function errorCodeOf(error: unknown): ErrorCode | undefined {
  if (error instanceof ProviderError) return error.code;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code as ErrorCode;
  }
  return undefined;
}

function newDeepSeekDraft(): ProviderFormState {
  return {
    id: newProviderId(),
    name: DEEPSEEK_PRESET.name,
    kind: "deepseek",
    baseURL: DEEPSEEK_PRESET.baseURL,
    appendV1: false,
    apiKey: "",
    model: DEEPSEEK_PRESET.defaultModel,
    createdAt: Date.now(),
  };
}

function newCustomDraft(): ProviderFormState {
  return {
    ...newDeepSeekDraft(),
    name: `自定义 ${(settings?.providers.length ?? 0) + 1}`,
    kind: "custom",
    baseURL: "https://api.openai.com",
    appendV1: undefined,
    model: "",
  };
}

function injectStyles(): void {
  if (document.querySelector("style[data-ilmt-popup]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-ilmt-popup", "");
  style.textContent = themeCss + cssText;
  (document.head ?? document.documentElement).appendChild(style);
}

// --- shell / render ---

function buildShell(): void {
  root = document.getElementById("root") ?? document.body;
  root.replaceChildren();

  const header = el("header", "popup-header");
  header.append(el("span", "popup-logo"), el("h1", "popup-title", "翻译设置"));
  const openOptionsButton = el("button", "popup-open-options", "高级设置");
  openOptionsButton.type = "button";
  openOptionsButton.addEventListener("click", openOptions);
  header.appendChild(openOptionsButton);
  root.appendChild(header);

  const providerBar = el("div", "popup-provider-bar");
  providerSelect = el("select", "popup-provider-select");
  providerSelect.setAttribute("aria-label", "选择模型配置");
  providerSelect.addEventListener("change", onProviderSelectChange);
  addButton = el("button", "popup-add", "新增");
  addButton.type = "button";
  addButton.addEventListener("click", onAddProvider);
  providerBar.append(providerSelect, addButton);
  root.appendChild(providerBar);

  formHost = el("div", "popup-form-host");
  root.appendChild(formHost);

  const footer = el("footer", "popup-footer");
  const openSidepanel = el("button", "popup-open-sidepanel", "打开翻译侧栏");
  openSidepanel.type = "button";
  openSidepanel.addEventListener("click", openSidePanel);
  footer.append(openSidepanel, el("span", "popup-hint", "Alt+S 也能打开侧栏"));
  root.appendChild(footer);
}

function render(): void {
  if (!settings) {
    formHost.replaceChildren(el("p", "popup-read-error", "读取设置失败，请重试。"));
    return;
  }

  const providers = settings.providers;
  providerSelect.replaceChildren();
  const hasProviders = providers.length > 0;
  providerSelect.hidden = !hasProviders;

  if (hasProviders) {
    if (isNew) {
      const placeholder = el("option");
      placeholder.value = "";
      placeholder.textContent = "新增配置…";
      providerSelect.appendChild(placeholder);
    }
    for (const p of providers) {
      const option = el("option");
      option.value = p.id;
      option.textContent = p.name + (settings.activeProviderId === p.id ? "（当前）" : "");
      providerSelect.appendChild(option);
    }
    if (!isNew) {
      if (!current || !providers.some((p) => p.id === current!.id)) {
        current =
          providers.find((p) => p.id === settings!.activeProviderId) ?? providers[0];
      }
      providerSelect.value = current?.id ?? "";
    } else {
      providerSelect.value = "";
    }
  }

  renderForm();
}

function renderForm(): void {
  const base = isNew ? draft : current!;
  const kind = base.kind;

  const form = el("form", "popup-form");
  form.noValidate = true;

  if (isNew) {
    const kindSelect = el("select", "popup-kind");
    const deepseekOption = el("option", undefined, PROVIDER_KIND_LABELS.deepseek);
    deepseekOption.value = "deepseek";
    const customOption = el("option", undefined, PROVIDER_KIND_LABELS.custom);
    customOption.value = "custom";
    kindSelect.append(deepseekOption, customOption);
    kindSelect.value = kind;
    kindSelect.addEventListener("change", () => onKindChange(kindSelect.value));
    form.appendChild(field("类型", kindSelect));
  } else {
    form.appendChild(field("类型", el("div", "popup-kind-readonly", PROVIDER_KIND_LABELS[kind])));
  }

  const isDeepSeek = kind === "deepseek";

  if (!isDeepSeek) {
    const nameInput = el("input", "popup-name");
    nameInput.type = "text";
    nameInput.value = base.name;
    nameInput.placeholder = "例如：DeepSeek 官方";
    form.appendChild(field("名称", nameInput));

    const baseURLInput = el("input", "popup-baseURL");
    baseURLInput.type = "text";
    baseURLInput.value = base.baseURL;
    baseURLInput.placeholder = "https://api.openai.com";
    form.appendChild(field("接口地址", baseURLInput));

    const appendV1Input = el("input", "popup-appendV1");
    appendV1Input.type = "checkbox";
    appendV1Input.checked = base.appendV1 !== false;
    const appendV1Row = el("label", "popup-appendV1-row");
    appendV1Row.append(appendV1Input, document.createTextNode("自动补 /v1"));
    form.appendChild(appendV1Row);
  }

  const apiKeyInput = el("input", "popup-apiKey");
  apiKeyInput.type = "password";
  apiKeyInput.value = isNew ? base.apiKey : "";
  apiKeyInput.autocomplete = "new-password";
  apiKeyInput.placeholder = isNew
    ? "必填，仅保存在本机"
    : `已保存（${maskKey(base.apiKey)}），留空表示不修改`;
  form.appendChild(field("API Key", apiKeyInput));

  const modelField = el("div", "popup-field");
  modelField.appendChild(el("span", "popup-field-label", "模型"));
  const datalistId = "popup-model-options";
  const modelInput = el("input", "popup-model");
  modelInput.type = "text";
  modelInput.value = base.model;
  modelInput.placeholder = "输入模型名，或先拉取模型";
  modelInput.setAttribute("list", datalistId);
  const fetchButton = el("button", "popup-fetch-models", "拉取模型");
  fetchButton.type = "button";
  const datalist = el("datalist", "popup-model-options");
  datalist.id = datalistId;
  fillDatalist(datalist, kind);
  const modelRow = el("div", "popup-model-row");
  modelRow.append(modelInput, fetchButton, datalist);
  modelField.appendChild(modelRow);
  const modelsStatus = el("span", "popup-models-status");
  modelField.appendChild(modelsStatus);
  form.appendChild(modelField);

  const formMessage = el("div", "popup-form-message");
  const testResult = el("div", "popup-test-result");
  const saveStatus = el("span", "popup-save-status");
  form.append(formMessage, testResult, saveStatus);

  const actions = el("div", "popup-actions");
  const saveButton = el("button", "popup-save", "保存");
  saveButton.type = "submit";
  const testButton = el("button", "popup-test", "测试连接");
  testButton.type = "button";
  actions.append(saveButton, testButton);

  if (!isNew && current && settings && settings.activeProviderId !== current.id) {
    const setActiveButton = el("button", "popup-set-active", "设为当前");
    setActiveButton.type = "button";
    setActiveButton.addEventListener("click", () => void onSetActive());
    actions.appendChild(setActiveButton);
  }

  form.appendChild(actions);

  fetchButton.addEventListener("click", () => void onFetchModels(form));
  testButton.addEventListener("click", () => void onTestConnection(form));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onSave(form);
  });

  formHost.replaceChildren(form);
}

function fillDatalist(datalist: HTMLDataListElement, kind: ProviderKind): void {
  datalist.replaceChildren();
  if (kind === "deepseek") {
    for (const id of DEEPSEEK_PRESET.fallbackModels) {
      const option = document.createElement("option");
      option.value = id;
      datalist.appendChild(option);
    }
  }
}

// --- form reading / config ---

function readPatch(form: HTMLFormElement): Partial<ProviderFormState> {
  const base = isNew ? draft : current!;
  const kindSelect = form.querySelector<HTMLSelectElement>(".popup-kind");
  const kind: ProviderKind = kindSelect?.value === "deepseek" ? "deepseek" : base.kind;
  const isDeepSeek = kind === "deepseek";

  let name: string;
  let baseURL: string;
  let appendV1: boolean | undefined;

  if (isDeepSeek) {
    name = DEEPSEEK_PRESET.name;
    baseURL = DEEPSEEK_PRESET.baseURL;
    appendV1 = false;
  } else {
    name =
      form.querySelector<HTMLInputElement>(".popup-name")?.value.trim() || base.name;
    baseURL =
      form.querySelector<HTMLInputElement>(".popup-baseURL")?.value.trim() ?? base.baseURL;
    appendV1 =
      form.querySelector<HTMLInputElement>(".popup-appendV1")?.checked === false
        ? false
        : undefined;
  }

  const typedKey =
    form.querySelector<HTMLInputElement>(".popup-apiKey")?.value.trim() ?? "";
  const apiKey = typedKey === "" ? base.apiKey : typedKey;
  const model = form.querySelector<HTMLInputElement>(".popup-model")?.value.trim() ?? "";

  return { kind, name, baseURL, appendV1, apiKey, model };
}

function buildConfig(form: HTMLFormElement): ProviderConfig {
  const base: ProviderFormState = isNew ? draft : current!;
  return applyProviderForm(base, readPatch(form));
}

// --- handlers ---

function onProviderSelectChange(): void {
  if (!settings) return;
  const found = settings.providers.find((p) => p.id === providerSelect.value);
  if (!found) return;
  current = found;
  isNew = false;
  render();
}

function onAddProvider(): void {
  current = null;
  isNew = true;
  draft = newDeepSeekDraft();
  render();
}

function onKindChange(value: string): void {
  if (!isNew) return;
  const form = formHost.querySelector<HTMLFormElement>(".popup-form");
  const typedKey = form?.querySelector<HTMLInputElement>(".popup-apiKey")?.value.trim() ?? "";
  const typedModel = form?.querySelector<HTMLInputElement>(".popup-model")?.value.trim() ?? "";

  // Preserve the user's typed API key/model (and the draft id/createdAt);
  // only the kind-specific fields switch with the selected type.
  const next = value === "deepseek" ? newDeepSeekDraft() : newCustomDraft();
  next.id = draft.id;
  next.createdAt = draft.createdAt;
  if (typedKey !== "") next.apiKey = typedKey;
  if (typedModel !== "") next.model = typedModel;
  draft = next;
  renderForm();
}

async function onSave(form: HTMLFormElement): Promise<void> {
  const formMessage = form.querySelector<HTMLElement>(".popup-form-message");
  const saveStatus = form.querySelector<HTMLElement>(".popup-save-status");
  if (!settings) return;

  if (formMessage) formMessage.textContent = "";
  if (saveStatus) {
    saveStatus.textContent = "";
    saveStatus.className = "popup-save-status";
  }

  const cfg = buildConfig(form);
  const errors = validateProvider(cfg);
  if (errors.length > 0) {
    if (formMessage) {
      formMessage.textContent = FIELD_ERROR_LABELS[errors[0]] ?? "请检查填写内容";
    }
    return;
  }

  try {
    await upsertProvider(cfg);
    settings = await getSettings();
  } catch {
    if (saveStatus) {
      saveStatus.textContent = "保存失败";
      saveStatus.classList.add("error");
    }
    return;
  }

  current = settings.providers.find((p) => p.id === cfg.id) ?? cfg;
  isNew = false;
  render();

  const status = document.querySelector<HTMLElement>(".popup-save-status");
  if (status) {
    status.textContent = "已保存";
    status.classList.add("success");
  }
}

async function onFetchModels(form: HTMLFormElement): Promise<void> {
  const button = form.querySelector<HTMLButtonElement>(".popup-fetch-models");
  const datalist = form.querySelector<HTMLDataListElement>(".popup-model-options");
  const status = form.querySelector<HTMLElement>(".popup-models-status");
  if (!button || !datalist || !status) return;

  const cfg = buildConfig(form);

  button.disabled = true;
  button.textContent = "拉取中…";
  status.className = "popup-models-status";
  status.textContent = "";

  try {
    const models = await listModels(cfg);
    datalist.replaceChildren();
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      datalist.appendChild(option);
    }
    status.textContent = `已获取 ${models.length} 个模型`;
    status.classList.add("success");
  } catch {
    status.textContent = "拉取失败，可直接手填";
    status.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "拉取模型";
  }
}

async function onTestConnection(form: HTMLFormElement): Promise<void> {
  const result = form.querySelector<HTMLElement>(".popup-test-result");
  const button = form.querySelector<HTMLButtonElement>(".popup-test");
  if (!result || !button) return;

  const cfg = buildConfig(form);

  button.disabled = true;
  button.textContent = "测试中…";
  result.classList.remove("success", "error");
  result.textContent = "";

  const startedAt = performance.now();
  try {
    await complete(cfg, { messages: [{ role: "user", content: "ping" }], maxTokens: 1 });
    const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
    result.textContent = `连接成功（${elapsed} ms）`;
    result.classList.add("success");
  } catch (error) {
    const code = errorCodeOf(error);
    result.textContent = `连接失败：${code ? errorLabel(code) : "未知错误"}`;
    result.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "测试连接";
  }
}

async function onSetActive(): Promise<void> {
  if (!current || !settings) return;
  await saveSettings({ ...settings, activeProviderId: current.id });
  settings = await getSettings();
  render();
}

/**
 * Open the side panel inside the click gesture, preferring the current window.
 * `sidePanel.open` must run while the user gesture is live; the fallback query
 * therefore happens synchronously (no await before the first open attempt).
 */
function openSidePanel(): void {
  const close = (): void => window.close();

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

function openOptions(): void {
  try {
    const pending = chrome.runtime.openOptionsPage();
    void Promise.resolve(pending).catch(openOptionsInTab);
  } catch {
    openOptionsInTab();
  }
}

function openOptionsInTab(): void {
  try {
    void chrome.tabs
      .create({ url: chrome.runtime.getURL("options.html") })
      .catch(() => {});
  } catch {
    // 静默失败。
  }
}

// Auto-run on load.
void runPopup();
