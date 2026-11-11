/**
 * Second-level model manager used inside the popup settings view.
 *
 * The list and the full editor live on this one second-level page. No network
 * request is made until the user clicks 拉取模型 / 测试连接.
 */

import { DEEPSEEK_PRESET, PROVIDER_KIND_LABELS } from "../shared/providers";
import {
  getSettings,
  removeProvider,
  saveSettings,
  upsertProvider,
} from "../shared/storage";
import type { ProviderConfig, ProviderKind, Settings } from "../shared/types";
import { complete, listModels } from "../providers";
import {
  applyProviderForm,
  errorLabel,
  maskKey,
  validateProvider,
  type ProviderFormState,
} from "./provider-form";
import {
  el,
  errorCodeOf,
  field,
  makeButton,
  makeOverrideNumber,
  metaItem,
  newProviderId,
  now,
  numericOrBlank,
} from "./components";

const FIELD_ERROR_LABELS: Record<string, string> = {
  baseURL: "请填写接口地址",
  apiKey: "请填写 API Key",
  model: "请选择或填写模型",
};

interface ProviderFormControls {
  base: ProviderConfig;
  form: HTMLFormElement;
  kind: HTMLSelectElement | null;
  name: HTMLInputElement;
  nameField: HTMLElement;
  baseURL: HTMLInputElement;
  baseURLField: HTMLElement;
  appendV1: HTMLInputElement;
  appendV1Row: HTMLElement;
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
  dirty: boolean;
}

export interface ProviderManagerCallbacks {
  onBack(): void;
  onSettingsChanged(settings: Settings): void;
}

export interface ProviderManagerHandle {
  element: HTMLElement;
  openNew(): void;
}

export function mountProviderManager(
  host: HTMLElement,
  initialSettings: Settings,
  startNew: boolean,
  callbacks: ProviderManagerCallbacks,
): ProviderManagerHandle {
  let settings = initialSettings;
  let currentForm: ProviderFormControls | null = null;
  let pendingAfterDiscard: (() => void) | null = null;
  let armedDeleteId = "";

  const element = el("div", "settings-subview provider-manager");
  const head = el("div", "subview-head");
  const backButton = makeButton("← 返回", "settings-back");
  const title = el("h2", "subview-title", "模型管理");
  const addButton = makeButton("新增配置", "provider-add");
  head.append(backButton, title, addButton);

  const status = el("span", "manager-status");
  status.hidden = true;
  const list = el("div", "provider-list");
  const formHost = el("div", "provider-form-host");
  element.append(head, status, list, formHost);
  host.replaceChildren(element);

  backButton.addEventListener("click", () => {
    if (currentForm?.dirty) {
      showDiscardConfirm(() => callbacks.onBack());
      return;
    }
    callbacks.onBack();
  });
  addButton.addEventListener("click", () => guardDiscard(() => openForm(null)));

  function showStatus(text: string, kind: "success" | "error" = "success"): void {
    status.textContent = text;
    status.className = `manager-status ${kind}`;
    status.hidden = false;
  }

  function guardDiscard(action: () => void): void {
    if (currentForm?.dirty) {
      pendingAfterDiscard = action;
      showDiscardConfirm(action);
      return;
    }
    action();
  }

  function showDiscardConfirm(action: () => void): void {
    if (!currentForm) return;
    pendingAfterDiscard = action;
    let box = currentForm.form.querySelector<HTMLElement>(".pf-discard");
    if (!box) {
      box = el("div", "pf-discard");
      box.append(el("span", "pf-discard-text", "放弃未保存的修改？"));
      const yes = makeButton("放弃", "pf-discard-yes");
      const no = makeButton("继续编辑", "pf-discard-no");
      box.append(yes, no);
      currentForm.form.appendChild(box);
      yes.addEventListener("click", () => {
        const next = pendingAfterDiscard;
        pendingAfterDiscard = null;
        closeForm();
        next?.();
      });
      no.addEventListener("click", () => {
        pendingAfterDiscard = null;
        box?.remove();
      });
    }
    box.scrollIntoView?.({ block: "nearest" });
    void action;
  }

  function renderList(): void {
    list.replaceChildren();
    if (settings.providers.length === 0) {
      list.appendChild(el("p", "empty", "还没有模型配置。点击「新增配置」开始。"));
      return;
    }
    for (const provider of settings.providers) {
      list.appendChild(renderProviderCard(provider));
    }
  }

  function renderProviderCard(provider: ProviderConfig): HTMLElement {
    const card = el("article", "provider-card");
    card.dataset.providerId = provider.id;

    const cardHead = el("div", "provider-card-head");
    cardHead.appendChild(el("h3", "provider-name", provider.name));
    if (settings.activeProviderId === provider.id) {
      cardHead.appendChild(el("span", "badge", "当前使用"));
    }
    card.appendChild(cardHead);

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
    editButton.addEventListener("click", () => guardDiscard(() => openForm(provider)));
    const copyButton = makeButton("复制", "provider-copy");
    copyButton.addEventListener("click", () => guardDiscard(() => void copyProvider(provider)));
    const deleteButton = makeButton("删除", "provider-delete");
    deleteButton.addEventListener("click", () => {
      if (armedDeleteId !== provider.id) {
        armedDeleteId = provider.id;
        deleteButton.textContent = "确认删除";
        deleteButton.classList.add("danger");
        return;
      }
      guardDiscard(() => void performDelete(provider));
    });
    actions.append(editButton, copyButton, testButton, deleteButton);

    if (settings.activeProviderId !== provider.id) {
      const setActiveButton = makeButton("设为当前", "provider-set-active");
      setActiveButton.addEventListener("click", () => {
        void setActive(provider);
      });
      actions.appendChild(setActiveButton);
    }

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

  function openForm(provider: ProviderConfig | null): void {
    const base: ProviderConfig = provider
      ? {
          ...provider,
          extraHeaders: provider.extraHeaders ? { ...provider.extraHeaders } : undefined,
          overrides: provider.overrides ? { ...provider.overrides } : undefined,
        }
      : {
          id: newProviderId(),
          name: DEEPSEEK_PRESET.name,
          kind: "deepseek",
          baseURL: DEEPSEEK_PRESET.baseURL,
          appendV1: false,
          apiKey: "",
          model: DEEPSEEK_PRESET.defaultModel,
          createdAt: Date.now(),
        };

    const form = el("form", "provider-form");
    form.noValidate = true;
    form.appendChild(el("h3", "form-title", provider ? `编辑：${provider.name}` : "新增模型配置"));

    let kindSelect: HTMLSelectElement | null = null;
    if (provider) {
      const kindLabel = el("div", "pf-kind-readonly", PROVIDER_KIND_LABELS[base.kind]);
      kindLabel.dataset.kind = base.kind;
      form.appendChild(field("类型", kindLabel));
    } else {
      kindSelect = el("select", "pf-kind");
      const deepseekOption = el("option", undefined, PROVIDER_KIND_LABELS.deepseek);
      deepseekOption.value = "deepseek";
      const customOption = el("option", undefined, PROVIDER_KIND_LABELS.custom);
      customOption.value = "custom";
      kindSelect.append(deepseekOption, customOption);
      kindSelect.value = base.kind;
      form.appendChild(field("类型", kindSelect));
    }

    const nameInput = el("input", "pf-name");
    nameInput.type = "text";
    nameInput.value = base.name;
    nameInput.placeholder = "例如：DeepSeek 官方";
    const nameField = field("名称", nameInput);
    nameField.classList.add("pf-name-field");
    form.appendChild(nameField);

    const baseURLInput = el("input", "pf-baseURL");
    baseURLInput.type = "text";
    baseURLInput.value = base.baseURL;
    baseURLInput.placeholder = "https://api.openai.com";
    const baseURLField = field(
      "接口地址",
      baseURLInput,
      "可省略 /v1，发送请求时会按需自动补全。",
    );
    baseURLField.classList.add("pf-baseURL-field");
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
    if (base.kind === "deepseek") {
      for (const id of DEEPSEEK_PRESET.fallbackModels) {
        const option = document.createElement("option");
        option.value = id;
        datalist.appendChild(option);
      }
    }
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
    overridesField.appendChild(
      el("legend", undefined, "此配置的覆盖项（留空继承全局）"),
    );
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
    form.appendChild(
      field("系统提示词（可选）", systemPromptInput, "留空表示使用全局提示词。"),
    );

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
      kind: kindSelect,
      name: nameInput,
      nameField,
      baseURL: baseURLInput,
      baseURLField,
      appendV1: appendV1Input,
      appendV1Row,
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
      dirty: false,
    };

    const syncKindFields = (): void => {
      const kind: ProviderKind = kindSelect
        ? kindSelect.value === "deepseek"
          ? "deepseek"
          : "custom"
        : base.kind;
      const isDeepSeek = kind === "deepseek";

      nameField.hidden = isDeepSeek;
      baseURLField.hidden = isDeepSeek;
      appendV1Row.hidden = isDeepSeek;

      if (isDeepSeek) {
        baseURLInput.value = DEEPSEEK_PRESET.baseURL;
        appendV1Input.checked = false;
        if (!provider && (nameInput.value.trim() === "" || nameInput.value.startsWith("自定义 "))) {
          nameInput.value = DEEPSEEK_PRESET.name;
        }
        return;
      }

      if (!provider && nameInput.value === DEEPSEEK_PRESET.name) {
        nameInput.value = `自定义 ${settings.providers.length + 1}`;
      }
      if (!provider && baseURLInput.value === DEEPSEEK_PRESET.baseURL) {
        baseURLInput.value = "https://api.openai.com";
      }
      if (!provider) {
        appendV1Input.checked = true;
      }
    };

    kindSelect?.addEventListener("change", syncKindFields);
    syncKindFields();

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

    cancelButton.addEventListener("click", () => {
      if (controls.dirty) {
        showDiscardConfirm(closeForm);
        return;
      }
      closeForm();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveForm();
    });
    form.addEventListener("input", () => {
      controls.dirty = true;
    });
    form.addEventListener("change", () => {
      controls.dirty = true;
    });

    currentForm = controls;
    formHost.replaceChildren(form);
    form.scrollIntoView?.({ block: "nearest" });
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
    const kind: ProviderKind = controls.kind
      ? controls.kind.value === "deepseek"
        ? "deepseek"
        : "custom"
      : controls.base.kind;
    const isDeepSeek = kind === "deepseek";
    return {
      id: controls.base.id,
      name:
        controls.name.value.trim() || (isDeepSeek ? DEEPSEEK_PRESET.name : controls.base.name),
      kind,
      baseURL: isDeepSeek ? DEEPSEEK_PRESET.baseURL : controls.baseURL.value.trim(),
      appendV1: isDeepSeek ? false : controls.appendV1.checked ? undefined : false,
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
    if (!controls) return;

    clearFormErrors(controls.form);
    const cfg = applyProviderForm(readForm(controls), {});
    const errors = validateProvider(cfg);
    if (errors.length > 0) {
      showFormErrors(controls, errors);
      return;
    }

    try {
      await upsertProvider(cfg);
      settings = await getSettings();
      callbacks.onSettingsChanged(settings);
      closeForm();
      renderList();
      showStatus("已保存");
    } catch {
      showStatus("保存失败", "error");
    }
  }

  function closeForm(): void {
    currentForm = null;
    pendingAfterDiscard = null;
    formHost.replaceChildren();
  }

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
    callbacks.onSettingsChanged(settings);
    renderList();
    showStatus("已复制");
  }

  async function performDelete(provider: ProviderConfig): Promise<void> {
    await removeProvider(provider.id);
    settings = await getSettings();
    if (currentForm?.base.id === provider.id) closeForm();
    callbacks.onSettingsChanged(settings);
    renderList();
    showStatus("已删除");
  }

  async function setActive(provider: ProviderConfig): Promise<void> {
    await saveSettings({ ...settings, activeProviderId: provider.id });
    settings = await getSettings();
    callbacks.onSettingsChanged(settings);
    renderList();
    showStatus("已设为当前模型");
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
      result.textContent = `连接失败：${code ? errorLabel(code) : "未知错误"}`;
      result.classList.add("error");
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  renderList();
  if (startNew) openForm(null);

  return {
    element,
    openNew: () => guardDiscard(() => openForm(null)),
  };
}
