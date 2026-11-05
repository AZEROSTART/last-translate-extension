/**
 * Options page UI. Vanilla DOM only — no framework, no inline scripts.
 *
 * Two regions: 自定义模型配置 (multi-provider CRUD, connection test, model
 * discovery) and 全局设置 (active provider, language, limits, prompt, trigger).
 * API keys stay in `chrome.storage.local`; the list only ever shows a mask.
 */

import { ProviderError } from "../shared/errors";
import {
  DEFAULT_SETTINGS,
  getSettings,
  removeProvider,
  saveSettings,
  upsertProvider,
} from "../shared/storage";
import type { ErrorCode, ProviderConfig, Settings } from "../shared/types";
import { complete, listModels } from "../providers";
import { TranslationCache } from "../background/cache";
import {
  applyProviderForm,
  errorLabel,
  maskKey,
  promptVersionFor,
  validateProvider,
  type ProviderFormState,
} from "./providers";
import cssText from "../styles/options.css?inline";

const TARGET_LANGUAGES: Array<[string, string]> = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en", "英语"],
  ["ja", "日语"],
  ["ko", "韩语"],
  ["fr", "法语"],
  ["de", "德语"],
  ["es", "西班牙语"],
  ["ru", "俄语"],
];

const FIELD_ERROR_LABELS: Record<string, string> = {
  baseURL: "请填写接口地址",
  apiKey: "请填写 API Key",
  model: "请选择或填写模型",
};

type TriggerMode = Settings["triggerMode"];

interface GlobalFields {
  activeRadios: HTMLInputElement[];
  targetLang: HTMLSelectElement;
  concurrency: HTMLInputElement;
  maxRPS: HTMLInputElement;
  temperature: HTMLInputElement;
  systemPrompt: HTMLTextAreaElement;
  triggerRadios: HTMLInputElement[];
  saveButton: HTMLButtonElement;
  clearCacheButton: HTMLButtonElement;
  cacheMessage: HTMLElement;
  saved: HTMLElement;
}

interface ProviderFormControls {
  base: ProviderConfig;
  form: HTMLFormElement;
  name: HTMLInputElement;
  baseURL: HTMLInputElement;
  appendV1: HTMLInputElement;
  apiKey: HTMLInputElement;
  model: HTMLInputElement;
  headers: HTMLElement;
  addHeader: HTMLButtonElement;
  concurrency: HTMLInputElement;
  maxRPS: HTMLInputElement;
  temperature: HTMLInputElement;
  systemPrompt: HTMLTextAreaElement;
  modelStatus: HTMLElement;
  testResult: HTMLElement;
  testButton: HTMLButtonElement;
  fieldInputs: Record<string, HTMLInputElement>;
}

let started = false;
let settings: Settings | null = null;

let root: HTMLElement;
let providerListEl: HTMLElement;
let providerFormHost: HTMLElement;
let globalEl: HTMLElement;
let globalFields: GlobalFields | null = null;
let currentForm: ProviderFormControls | null = null;

let resolveReady!: () => void;
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

const scope = globalThis as typeof globalThis & {
  __ilmtOptions?: {
    ready: Promise<void>;
    get settings(): Settings | null;
  };
};
scope.__ilmtOptions = {
  ready,
  get settings() {
    return settings;
  },
};

export function runOptions(): Promise<void> {
  if (started) return ready;
  started = true;
  void start();
  return ready;
}

async function start(): Promise<void> {
  try {
    settings = await getSettings();
  } catch {
    settings = null;
  }
  buildShell();
  injectStyles();
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

function makeButton(label: string, className: string): HTMLButtonElement {
  const button = el("button", className, label);
  button.type = "button";
  return button;
}

function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  const wrap = el("label", "field");
  wrap.appendChild(el("span", "field-label", labelText));
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el("span", "field-hint", hint));
  return wrap;
}

function metaItem(label: string, value: string): HTMLElement {
  const item = el("div", "meta-item");
  item.append(el("span", "meta-label", label), el("span", "meta-value", value));
  return item;
}

function makeNumberControl(
  labelText: string,
  className: string,
  value: number,
  min: number | undefined,
  max: number | undefined,
  step: number,
  hint: string,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label", "field");
  wrap.appendChild(el("span", "field-label", labelText));
  const input = el("input", className);
  input.type = "number";
  input.step = String(step);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.value = String(value);
  wrap.appendChild(input);
  wrap.appendChild(el("span", "field-hint", hint));
  return { wrap, input };
}

function makeOverrideNumber(
  className: string,
  value: number | undefined,
  opts: { min?: number; max?: number; step?: number } = {},
): HTMLInputElement {
  const input = el("input", className);
  input.type = "number";
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.step = String(opts.step ?? 1);
  input.value = value === undefined ? "" : String(value);
  input.placeholder = "继承全局";
  return input;
}

function injectStyles(): void {
  if (document.querySelector("style[data-ilmt-options]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-ilmt-options", "");
  style.textContent = cssText;
  (document.head ?? document.documentElement).appendChild(style);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readNumberOr(value: string, fallback: number): number {
  return value.trim() === "" ? fallback : readNumber(value, fallback);
}

function numericOrBlank(value: string): number | "" {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : "";
}

function newProviderId(): string {
  const cryptoApi = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function errorCodeOf(error: unknown): ErrorCode | undefined {
  if (error instanceof ProviderError) return error.code;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code as ErrorCode;
  }
  return undefined;
}

// --- shell / regions ---

function buildShell(): void {
  root = document.getElementById("root") ?? document.body;
  root.replaceChildren();

  const header = el("header", "page-header");
  header.append(
    el("h1", undefined, "翻译设置"),
    el("p", "page-subtitle", "所有配置只保存在本机浏览器中（chrome.storage.local 为明文存储）；API Key 只发送给你配置的接口地址。"),
  );
  root.appendChild(header);

  const providersSection = el("section", "card providers-section");
  const providerHead = el("div", "section-head");
  providerHead.appendChild(el("h2", undefined, "自定义模型配置"));
  const addButton = makeButton("新增配置", "provider-add");
  addButton.addEventListener("click", () => openForm(null));
  providerHead.appendChild(addButton);
  providersSection.appendChild(providerHead);

  providerListEl = el("div", "provider-list");
  providersSection.appendChild(providerListEl);

  providerFormHost = el("div", "provider-form-host");
  providersSection.appendChild(providerFormHost);
  root.appendChild(providersSection);

  const globalSection = el("section", "card global-section");
  globalSection.appendChild(el("h2", undefined, "全局设置"));
  globalEl = el("div", "global-body");
  globalSection.appendChild(globalEl);
  root.appendChild(globalSection);

  if (!settings) {
    providerListEl.appendChild(el("p", "empty", "读取设置失败，请刷新页面重试。"));
    return;
  }

  renderProviderList();
  renderGlobal();
}

// --- provider list ---

function renderProviderList(): void {
  providerListEl.replaceChildren();
  if (!settings) return;

  if (settings.providers.length === 0) {
    providerListEl.appendChild(el("p", "empty", "还没有模型配置。点击「新增配置」开始。"));
    return;
  }

  for (const provider of settings.providers) {
    providerListEl.appendChild(renderProviderCard(provider));
  }
}

function renderProviderCard(provider: ProviderConfig): HTMLElement {
  const card = el("article", "provider-card");
  card.dataset.providerId = provider.id;

  const head = el("div", "provider-card-head");
  head.appendChild(el("h3", "provider-name", provider.name));
  if (settings?.activeProviderId === provider.id) {
    head.appendChild(el("span", "badge", "当前使用"));
  }
  card.appendChild(head);

  const meta = el("div", "provider-meta");
  meta.append(
    metaItem("接口地址", provider.baseURL),
    metaItem("模型", provider.model),
    metaItem("API Key", maskKey(provider.apiKey)),
  );
  card.appendChild(meta);

  const overrideText = describeOverrides(provider);
  if (overrideText) card.appendChild(el("p", "provider-overrides", overrideText));

  const result = el("div", "provider-test-result");
  const testButton = makeButton("测试连接", "provider-test");
  testButton.addEventListener("click", () => {
    void runConnectionTest(provider, result, testButton);
  });

  const actions = el("div", "provider-actions");
  const editButton = makeButton("编辑", "provider-edit");
  editButton.addEventListener("click", () => openForm(provider));
  const copyButton = makeButton("复制", "provider-copy");
  copyButton.addEventListener("click", () => {
    void copyProvider(provider);
  });
  const deleteButton = makeButton("删除", "provider-delete");
  deleteButton.addEventListener("click", () => {
    void deleteProvider(provider);
  });
  actions.append(editButton, copyButton, testButton, deleteButton);

  card.append(actions, result);
  return card;
}

function describeOverrides(provider: ProviderConfig): string {
  const parts: string[] = [];
  const overrides = provider.overrides ?? {};
  if (overrides.concurrency !== undefined) parts.push(`并发 ${overrides.concurrency}`);
  if (overrides.maxRPS !== undefined) parts.push(`RPS ${overrides.maxRPS}`);
  if (overrides.temperature !== undefined) parts.push(`温度 ${overrides.temperature}`);
  if (overrides.systemPrompt) parts.push("自定义提示词");
  const headerCount = provider.extraHeaders ? Object.keys(provider.extraHeaders).length : 0;
  if (headerCount > 0) parts.push(`请求头 ${headerCount} 条`);
  return parts.length > 0 ? `覆盖：${parts.join(" · ")}` : "";
}

// --- provider form ---

function openForm(provider: ProviderConfig | null): void {
  if (!settings) return;

  const base: ProviderConfig = provider
    ? {
        ...provider,
        extraHeaders: provider.extraHeaders ? { ...provider.extraHeaders } : undefined,
        overrides: provider.overrides ? { ...provider.overrides } : undefined,
      }
    : {
        id: newProviderId(),
        name: `自定义 ${settings.providers.length + 1}`,
        kind: "custom",
        baseURL: "https://api.openai.com",
        apiKey: "",
        model: "",
        createdAt: Date.now(),
      };

  const form = el("form", "provider-form");
  // Clamp numeric overrides ourselves; native min/max validation would block
  // the submit before the user's out-of-range value could be corrected.
  form.noValidate = true;
  form.appendChild(el("h3", "form-title", provider ? `编辑：${provider.name}` : "新增模型配置"));

  const nameInput = el("input", "pf-name");
  nameInput.type = "text";
  nameInput.value = base.name;
  nameInput.placeholder = "例如：DeepSeek 官方";
  form.appendChild(field("名称", nameInput));

  const baseURLInput = el("input", "pf-baseURL");
  baseURLInput.type = "text";
  baseURLInput.value = base.baseURL;
  baseURLInput.placeholder = "https://api.openai.com";
  const baseURLField = field("接口地址", baseURLInput, "可省略 /v1，发送请求时会按需自动补全。");
  form.appendChild(baseURLField);
  const appendV1Input = el("input", "pf-appendV1");
  appendV1Input.type = "checkbox";
  appendV1Input.checked = base.appendV1 !== false;
  const appendV1Row = el("label", "checkbox-row pf-appendV1-row");
  appendV1Row.append(appendV1Input, "自动补 /v1");
  form.appendChild(appendV1Row);

  const apiKeyInput = el("input", "pf-apiKey");
  apiKeyInput.type = "password";
  apiKeyInput.value = "";
  apiKeyInput.autocomplete = "new-password";
  apiKeyInput.placeholder = provider
    ? `已保存（${maskKey(provider.apiKey)}），留空表示不修改`
    : "必填，仅保存在本机";
  form.appendChild(
    field(
      "API Key",
      apiKeyInput,
      "只写入本机 chrome.storage.local，不会发送给除该配置接口以外的任何地址。",
    ),
  );

  const modelField = el("div", "field");
  modelField.appendChild(el("span", "field-label", "模型"));
  const datalistId = `model-options-${base.id}`;
  const modelInput = el("input", "pf-model");
  modelInput.type = "text";
  modelInput.value = base.model;
  modelInput.placeholder = "输入模型名，或先拉取模型";
  modelInput.setAttribute("list", datalistId);
  const fetchButton = makeButton("拉取模型", "pf-fetch-models");
  const datalist = el("datalist");
  datalist.id = datalistId;
  const modelRow = el("div", "model-row");
  modelRow.append(modelInput, fetchButton, datalist);
  modelField.appendChild(modelRow);
  const modelStatus = el("span", "pf-models-status");
  modelField.appendChild(modelStatus);
  form.appendChild(modelField);

  const headersField = el("fieldset", "field-group");
  headersField.appendChild(el("legend", undefined, "自定义请求头"));
  const headers = el("div", "pf-headers");
  headersField.appendChild(headers);
  const addHeader = makeButton("添加请求头", "pf-header-add");
  const headerHint = el("span", "field-hint", "最多 5 条，值里可用 {{apiKey}}");
  headersField.append(addHeader, headerHint);
  form.appendChild(headersField);

  const overridesField = el("fieldset", "field-group");
  overridesField.appendChild(el("legend", undefined, "此配置的覆盖项（留空继承全局）"));
  const concurrencyInput = makeOverrideNumber("pf-concurrency", base.overrides?.concurrency, {
    min: 1,
    max: 10,
  });
  const maxRPSInput = makeOverrideNumber("pf-maxRPS", base.overrides?.maxRPS, {
    min: 1,
    max: 20,
  });
  const temperatureInput = makeOverrideNumber("pf-temperature", base.overrides?.temperature, {
    step: 0.1,
  });
  const overrideGrid = el("div", "field-grid");
  overrideGrid.append(
    field("并发（1–10）", concurrencyInput, "留空继承全局"),
    field("每秒请求（1–20）", maxRPSInput, "留空继承全局"),
    field("温度", temperatureInput, "留空继承全局"),
  );
  overridesField.appendChild(overrideGrid);
  form.appendChild(overridesField);

  const systemPromptInput = el("textarea", "pf-systemPrompt");
  systemPromptInput.rows = 3;
  systemPromptInput.value = base.overrides?.systemPrompt ?? "";
  systemPromptInput.placeholder = "留空继承全局提示词";
  form.appendChild(field("系统提示词（可选）", systemPromptInput, "留空表示使用全局提示词。"));

  const testResult = el("div", "pf-test-result");
  const testButton = makeButton("测试连接", "pf-test-connection");
  const saveButton = el("button", "pf-save", "保存配置");
  saveButton.type = "submit";
  const cancelButton = makeButton("取消", "pf-cancel");
  const formActions = el("div", "form-actions");
  formActions.append(saveButton, cancelButton, testButton, testResult);
  form.appendChild(formActions);

  const controls: ProviderFormControls = {
    base,
    form,
    name: nameInput,
    baseURL: baseURLInput,
    appendV1: appendV1Input,
    apiKey: apiKeyInput,
    model: modelInput,
    headers,
    addHeader,
    concurrency: concurrencyInput,
    maxRPS: maxRPSInput,
    temperature: temperatureInput,
    systemPrompt: systemPromptInput,
    modelStatus,
    testResult,
    testButton,
    fieldInputs: {
      baseURL: baseURLInput,
      apiKey: apiKeyInput,
      model: modelInput,
    },
  };

  const syncHeaderControls = (): void => {
    addHeader.disabled = headers.querySelectorAll(".pf-header-row").length >= 5;
  };
  const createHeaderRow = (headerName = "", headerValue = ""): HTMLElement => {
    const row = el("div", "pf-header-row");
    const name = el("input", "pf-header-name");
    name.type = "text";
    name.placeholder = "Header 名称";
    name.value = headerName;
    const value = el("input", "pf-header-value");
    value.type = "text";
    value.placeholder = "值";
    value.value = headerValue;
    const remove = makeButton("移除", "pf-header-remove");
    remove.addEventListener("click", () => {
      row.remove();
      syncHeaderControls();
    });
    row.append(name, value, remove);
    return row;
  };

  addHeader.addEventListener("click", () => {
    if (headers.querySelectorAll(".pf-header-row").length >= 5) return;
    headers.appendChild(createHeaderRow());
    syncHeaderControls();
  });

  const initialHeaders = Object.entries(base.extraHeaders ?? {}).slice(0, 5);
  for (const [headerName, headerValue] of initialHeaders) {
    headers.appendChild(createHeaderRow(headerName, headerValue));
  }
  if (initialHeaders.length === 0) headers.appendChild(createHeaderRow());
  syncHeaderControls();

  fetchButton.addEventListener("click", async () => {
    const cfg = applyProviderForm(readForm(controls), {});
    fetchButton.disabled = true;
    fetchButton.textContent = "拉取中…";
    modelStatus.className = "pf-models-status";
    modelStatus.textContent = "";
    try {
      const models = await listModels(cfg);
      datalist.replaceChildren();
      for (const model of models) {
        const option = document.createElement("option");
        option.value = model.id;
        datalist.appendChild(option);
      }
      modelStatus.textContent = `已获取 ${models.length} 个模型`;
      modelStatus.classList.add("success");
    } catch {
      modelStatus.textContent = "拉取失败，可直接手填";
      modelStatus.classList.add("error");
    } finally {
      fetchButton.disabled = false;
      fetchButton.textContent = "拉取模型";
    }
  });

  testButton.addEventListener("click", () => {
    const cfg = applyProviderForm(readForm(controls), {});
    void runConnectionTest(cfg, testResult, testButton);
  });

  cancelButton.addEventListener("click", closeForm);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveForm();
  });

  currentForm = controls;
  providerFormHost.replaceChildren(form);
  nameInput.focus();
}

function readForm(controls: ProviderFormControls): ProviderFormState {
  const headers: Record<string, string> = {};
  let headerCount = 0;

  for (const row of Array.from(
    controls.headers.querySelectorAll<HTMLElement>(".pf-header-row"),
  )) {
    const name = row.querySelector<HTMLInputElement>(".pf-header-name")?.value.trim() ?? "";
    if (name === "") continue;
    if (headerCount >= 5) break;
    headers[name] = row.querySelector<HTMLInputElement>(".pf-header-value")?.value ?? "";
    headerCount += 1;
  }

  const typedKey = controls.apiKey.value.trim();
  return {
    id: controls.base.id,
    name: controls.name.value.trim() || controls.base.name,
    kind: "custom",
    baseURL: controls.baseURL.value.trim(),
    appendV1: controls.appendV1.checked ? undefined : false,
    apiKey: typedKey === "" ? controls.base.apiKey : typedKey,
    model: controls.model.value.trim(),
    extraHeaders: headerCount > 0 ? headers : undefined,
    overrides: {
      concurrency: numericOrBlank(controls.concurrency.value),
      maxRPS: numericOrBlank(controls.maxRPS.value),
      temperature: numericOrBlank(controls.temperature.value),
      systemPrompt: controls.systemPrompt.value,
    },
    createdAt: controls.base.createdAt,
    lastUsedAt: controls.base.lastUsedAt,
  };
}

function clearFormErrors(form: HTMLFormElement): void {
  form.querySelectorAll(".field-error").forEach((error) => error.remove());
}

function showFormErrors(controls: ProviderFormControls, errors: string[]): void {
  for (const code of errors) {
    const input = controls.fieldInputs[code];
    if (!input) continue;
    const error = el("span", "field-error", FIELD_ERROR_LABELS[code] ?? "请填写");
    input.insertAdjacentElement("afterend", error);
  }
}

async function saveForm(): Promise<void> {
  const controls = currentForm;
  if (!controls || !settings) return;

  clearFormErrors(controls.form);
  const cfg = applyProviderForm(readForm(controls), {});
  const errors = validateProvider(cfg);
  if (errors.length > 0) {
    showFormErrors(controls, errors);
    return;
  }

  await upsertProvider(cfg);
  settings = await getSettings();
  closeForm();
  renderProviderList();
  renderGlobal();
}

function closeForm(): void {
  currentForm = null;
  providerFormHost.replaceChildren();
}

// --- provider actions ---

async function copyProvider(provider: ProviderConfig): Promise<void> {
  const copy: ProviderConfig = {
    ...provider,
    id: newProviderId(),
    name: `${provider.name} 副本`,
    createdAt: Date.now(),
    extraHeaders: provider.extraHeaders ? { ...provider.extraHeaders } : undefined,
    overrides: provider.overrides ? { ...provider.overrides } : undefined,
  };

  await upsertProvider(copy);
  settings = await getSettings();
  renderProviderList();
  renderGlobal();
}

async function deleteProvider(provider: ProviderConfig): Promise<void> {
  if (!window.confirm("确认删除该配置？")) return;

  await removeProvider(provider.id);
  settings = await getSettings();
  if (currentForm?.base.id === provider.id) closeForm();
  renderProviderList();
  renderGlobal();
}

async function runConnectionTest(
  cfg: ProviderConfig,
  result: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  const label = button.textContent ?? "测试连接";
  button.disabled = true;
  button.textContent = "测试中…";
  result.classList.remove("success", "error");
  result.textContent = "";

  const startedAt = now();
  try {
    await complete(cfg, {
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    });
    const elapsed = Math.max(0, Math.round(now() - startedAt));
    result.textContent = `连接成功（${elapsed} ms）`;
    result.classList.add("success");
  } catch (error) {
    const code = errorCodeOf(error);
    // Only the classified label is shown: provider messages may echo request
    // details and must never be trusted to be key-free in the UI.
    result.textContent = `连接失败：${code ? errorLabel(code) : "未知错误"}`;
    result.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// --- global settings ---

function renderGlobal(): void {
  if (!settings) return;
  globalEl.replaceChildren();
  const s = settings;

  const providersField = el("fieldset", "field-group");
  providersField.appendChild(el("legend", undefined, "默认使用的模型配置"));
  const activeRadios: HTMLInputElement[] = [];
  if (s.providers.length === 0) {
    providersField.appendChild(el("p", "empty", "暂无模型配置，请先在上方新增一套。"));
  } else {
    const radioRow = el("div", "radio-row");
    for (const provider of s.providers) {
      const option = el("label", "radio-option");
      const radio = el("input", "global-active-provider");
      radio.type = "radio";
      radio.name = "active-provider";
      radio.value = provider.id;
      radio.checked = s.activeProviderId === provider.id;
      option.append(radio, document.createTextNode(provider.name));
      radioRow.appendChild(option);
      activeRadios.push(radio);
    }
    providersField.appendChild(radioRow);
  }
  globalEl.appendChild(providersField);

  const targetField = el("label", "field");
  targetField.appendChild(el("span", "field-label", "目标语言"));
  const targetLang = el("select", "global-targetLang");
  for (const [value, label] of TARGET_LANGUAGES) {
    const option = el("option");
    option.value = value;
    option.textContent = label;
    targetLang.appendChild(option);
  }
  if (!Array.from(targetLang.options).some((option) => option.value === s.targetLang)) {
    const custom = el("option");
    custom.value = s.targetLang;
    custom.textContent = s.targetLang;
    targetLang.appendChild(custom);
  }
  targetLang.value = s.targetLang;
  targetField.appendChild(targetLang);
  globalEl.appendChild(targetField);

  const numericGrid = el("div", "field-grid");
  const concurrency = makeNumberControl(
    "并发上限",
    "global-concurrency",
    s.concurrency,
    1,
    10,
    1,
    "同时进行的请求数",
  );
  const maxRPS = makeNumberControl(
    "每秒请求上限",
    "global-maxRPS",
    s.maxRPS,
    1,
    20,
    1,
    "每秒最多发起的请求数",
  );
  const temperature = makeNumberControl(
    "温度",
    "global-temperature",
    s.temperature,
    undefined,
    undefined,
    0.1,
    "0 表示输出更稳定",
  );
  numericGrid.append(concurrency.wrap, maxRPS.wrap, temperature.wrap);
  globalEl.appendChild(numericGrid);

  const promptField = el("label", "field");
  promptField.appendChild(el("span", "field-label", "全局系统提示词"));
  const systemPrompt = el("textarea", "global-systemPrompt");
  systemPrompt.rows = 4;
  systemPrompt.value = s.systemPrompt;
  promptField.appendChild(systemPrompt);
  promptField.appendChild(
    el("span", "field-hint", "修改后会自动更新缓存版本；{{targetLang}} 发送前替换为目标语言。"),
  );
  globalEl.appendChild(promptField);

  const triggerField = el("fieldset", "field-group");
  triggerField.appendChild(el("legend", undefined, "翻译触发方式"));
  const triggerRow = el("div", "radio-row");
  const triggerRadios: HTMLInputElement[] = [];
  const triggerOptions: Array<[TriggerMode, string]> = [
    ["shortcut", "快捷键触发"],
    ["auto-current-site", "自动（当前站点）"],
  ];
  for (const [value, label] of triggerOptions) {
    const option = el("label", "radio-option");
    const radio = el("input", "global-triggerMode");
    radio.type = "radio";
    radio.name = "trigger-mode";
    radio.value = value;
    radio.checked = s.triggerMode === value;
    option.append(radio, document.createTextNode(label));
    triggerRow.appendChild(option);
    triggerRadios.push(radio);
  }
  triggerField.appendChild(triggerRow);
  globalEl.appendChild(triggerField);

  const actions = el("div", "global-actions");
  const saveButton = makeButton("保存设置", "global-save");
  saveButton.addEventListener("click", () => {
    void saveGlobal();
  });
  const clearCacheButton = makeButton("清空缓存", "global-clear-cache");
  clearCacheButton.addEventListener("click", () => {
    void clearCache();
  });
  const saved = el("span", "global-saved", "已保存");
  saved.hidden = true;
  const cacheMessage = el("span", "global-cache-message");
  cacheMessage.hidden = true;
  actions.append(saveButton, clearCacheButton, saved, cacheMessage);
  globalEl.appendChild(actions);

  globalFields = {
    activeRadios,
    targetLang,
    concurrency: concurrency.input,
    maxRPS: maxRPS.input,
    temperature: temperature.input,
    systemPrompt,
    triggerRadios,
    saveButton,
    clearCacheButton,
    cacheMessage,
    saved,
  };
}

async function clearCache(): Promise<void> {
  if (!globalFields) return;
  const fields = globalFields;
  if (!window.confirm("确认清空翻译缓存？")) return;

  fields.clearCacheButton.disabled = true;
  fields.cacheMessage.hidden = false;
  fields.cacheMessage.textContent = "清空中…";
  fields.cacheMessage.className = "global-cache-message";
  try {
    await new TranslationCache("ilmt").clear();
    fields.cacheMessage.textContent = "已清空缓存";
    fields.cacheMessage.className = "global-cache-message success";
  } catch {
    fields.cacheMessage.textContent = "清空失败";
    fields.cacheMessage.className = "global-cache-message error";
  } finally {
    fields.clearCacheButton.disabled = false;
  }
}

async function saveGlobal(): Promise<void> {
  if (!settings || !globalFields) return;
  const fields = globalFields;

  const activeProviderId =
    fields.activeRadios.find((radio) => radio.checked)?.value ??
    fields.activeRadios[0]?.value ??
    "";

  const concurrency = clampInt(
    readNumberOr(fields.concurrency.value, settings.concurrency),
    1,
    10,
  );
  const maxRPS = clampInt(readNumberOr(fields.maxRPS.value, settings.maxRPS), 1, 20);
  const temperature = readNumberOr(fields.temperature.value, settings.temperature);
  const systemPrompt = fields.systemPrompt.value;
  const targetLang = fields.targetLang.value;
  const triggerMode: TriggerMode =
    fields.triggerRadios.find((radio) => radio.checked)?.value === "auto-current-site"
      ? "auto-current-site"
      : "shortcut";
  const effectivePrompt = systemPrompt.trim() ? systemPrompt : DEFAULT_SETTINGS.systemPrompt;
  const promptVersion =
    systemPrompt !== settings.systemPrompt || settings.promptVersion === ""
      ? await promptVersionFor(effectivePrompt)
      : settings.promptVersion;

  const next: Settings = {
    ...settings,
    activeProviderId,
    targetLang,
    concurrency,
    maxRPS,
    temperature,
    systemPrompt,
    promptVersion,
    triggerMode,
  };

  try {
    await saveSettings(next);
    settings = await getSettings();
    fields.concurrency.value = String(concurrency);
    fields.maxRPS.value = String(maxRPS);
    fields.temperature.value = String(temperature);
    renderProviderList();
    fields.saved.textContent = "已保存";
  } catch {
    fields.saved.textContent = "保存失败";
  }
  fields.saved.hidden = false;
}

// Auto-run on load.
void runOptions();
