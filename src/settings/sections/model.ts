import type { ProviderConfig, Settings } from "../../shared/types";
import { complete } from "../../providers";
import { el, errorCodeOf, makeButton, now } from "../components";
import { errorLabel, maskKey } from "../provider-form";
import type { SectionHandle, SettingsContext } from "./types";

export function createModelSection(ctx: SettingsContext): SectionHandle {
  const element = el("div", "settings-section-content model-section");
  const selectRow = el("div", "settings-model-select-row");
  const selectLabel = el("label", "field settings-model-field");
  selectLabel.appendChild(el("span", "field-label", "当前模型"));
  const select = el("select", "settings-active-provider");
  selectLabel.appendChild(select);
  selectRow.appendChild(selectLabel);
  element.appendChild(selectRow);

  const summary = el("div", "settings-model-summary");
  element.appendChild(summary);

  const result = el("div", "settings-model-test-result");
  const actions = el("div", "settings-model-actions");
  const testButton = makeButton("测试连接", "settings-model-test");
  const manageButton = makeButton("管理模型", "settings-manage-models");
  actions.append(testButton, manageButton);
  element.append(actions, result);

  const status = el("span", "settings-model-status");
  status.hidden = true;
  element.appendChild(status);

  function activeProvider(): ProviderConfig | undefined {
    const current = ctx.getSettings();
    return current.providers.find((provider) => provider.id === current.activeProviderId);
  }

  function render(): void {
    const current = ctx.getSettings();
    select.replaceChildren();

    if (current.providers.length === 0) {
      const option = el("option", undefined, "还没有模型配置");
      option.value = "";
      select.appendChild(option);
      select.disabled = true;
      manageButton.textContent = "添加模型";
      testButton.disabled = true;
      summary.textContent = "添加一套模型配置后即可开始翻译。";
      return;
    }

    select.disabled = false;
    manageButton.textContent = "管理模型";
    if (!current.activeProviderId) {
      const placeholder = el("option", undefined, "请选择模型");
      placeholder.value = "";
      select.appendChild(placeholder);
    }
    for (const provider of current.providers) {
      const option = el("option");
      option.value = provider.id;
      option.textContent =
        provider.name + (current.activeProviderId === provider.id ? "（当前）" : "");
      select.appendChild(option);
    }
    select.value = current.activeProviderId || "";

    const active = activeProvider();
    if (!active) {
      summary.textContent = "未选择当前模型。请在下方选择或到「管理模型」里设为当前。";
      testButton.disabled = true;
      return;
    }

    testButton.disabled = false;
    summary.replaceChildren();
    summary.append(
      el("div", "settings-model-name", active.name),
      el("div", "settings-model-meta", `${active.model} · ${maskKey(active.apiKey)}`),
      el("div", "settings-model-url", active.baseURL),
    );
  }

  select.addEventListener("change", () => {
    if (!select.value) return;
    status.hidden = false;
    status.textContent = "保存中…";
    void (async () => {
      try {
        await ctx.savePatch({ activeProviderId: select.value });
        status.textContent = "已切换当前模型";
      } catch {
        status.textContent = "保存失败";
      }
    })();
  });

  testButton.addEventListener("click", () => {
    const provider = activeProvider();
    if (!provider) return;
    void (async () => {
      testButton.disabled = true;
      testButton.textContent = "测试中…";
      result.classList.remove("success", "error");
      result.textContent = "";
      const startedAt = now();
      try {
        await complete(provider, {
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
        testButton.disabled = false;
        testButton.textContent = "测试连接";
      }
    })();
  });

  manageButton.addEventListener("click", () => {
    ctx.openModels(ctx.getSettings().providers.length === 0);
  });

  render();

  return {
    id: "model",
    element,
    summary: () => {
      const current = ctx.getSettings();
      if (current.providers.length === 0) return "还没有配置";
      const active = current.providers.find(
        (provider) => provider.id === current.activeProviderId,
      );
      return active ? `${active.name} · ${active.model}` : "未选择当前模型";
    },
    update: (next: Settings) => {
      void next;
      render();
    },
  };
}
