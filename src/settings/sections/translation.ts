import type { DomainPreset, Settings } from "../../shared/types";
import { DOMAIN_PRESETS } from "../../shared/preferences";
import {
  clampInt,
  el,
  makeButton,
  makeNumberControl,
  readNumberOr,
} from "../components";
import type { SectionHandle, SettingsContext } from "./types";

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

type TriggerMode = Settings["triggerMode"];

export function createTranslationSection(ctx: SettingsContext): SectionHandle {
  const element = el("div", "settings-section-content translation-section");
  const settings = ctx.getSettings();

  const targetField = el("label", "field");
  targetField.appendChild(el("span", "field-label", "目标语言"));
  const targetLang = el("select", "global-targetLang");
  for (const [value, label] of TARGET_LANGUAGES) {
    const option = el("option");
    option.value = value;
    option.textContent = label;
    targetLang.appendChild(option);
  }
  if (!Array.from(targetLang.options).some((option) => option.value === settings.targetLang)) {
    const custom = el("option");
    custom.value = settings.targetLang;
    custom.textContent = settings.targetLang;
    targetLang.appendChild(custom);
  }
  targetLang.value = settings.targetLang;
  targetField.appendChild(targetLang);
  element.appendChild(targetField);

  // Only general/tech/custom are exposed in v1; the other presets are
  // reserved in shared/preferences.ts and stay out of the UI on purpose.
  const styleField = el("fieldset", "field-group preference-field");
  styleField.appendChild(el("legend", undefined, "翻译风格"));
  const domainField = el("label", "field");
  domainField.appendChild(el("span", "field-label", "风格预设"));
  const preferenceDomain = el("select", "global-preference-domain");
  for (const domain of ["general", "tech", "custom"] as DomainPreset[]) {
    const option = el("option");
    option.value = domain;
    option.textContent = DOMAIN_PRESETS[domain].label;
    preferenceDomain.appendChild(option);
  }
  preferenceDomain.value = settings.preference.domain;
  domainField.appendChild(preferenceDomain);
  styleField.appendChild(domainField);

  const instructionsField = el("label", "field");
  instructionsField.appendChild(el("span", "field-label", "追加说明"));
  const preferenceInstructions = el("textarea", "global-preference-instructions");
  preferenceInstructions.rows = 3;
  preferenceInstructions.maxLength = 500;
  preferenceInstructions.placeholder = "例如：保留英文术语，语气口语化";
  preferenceInstructions.value = settings.preference.instructions;
  instructionsField.appendChild(preferenceInstructions);
  instructionsField.appendChild(
    el("span", "field-hint", "只影响用词与语气，不会改变译文格式；最多 500 字。"),
  );
  styleField.appendChild(instructionsField);
  element.appendChild(styleField);

  const scopeField = el("fieldset", "field-group");
  scopeField.appendChild(el("legend", undefined, "翻译范围"));
  const minParagraphLength = makeNumberControl(
    "最小翻译长度",
    "global-minParagraphLength",
    settings.minParagraphLength,
    4,
    100,
    1,
    "少于这个字符数的文本不翻译",
  );
  const contentOnlyRow = el("label", "checkbox-row");
  const contentOnly = el("input", "global-contentOnly");
  contentOnly.type = "checkbox";
  contentOnly.checked = settings.contentOnly !== false;
  contentOnlyRow.append(contentOnly, document.createTextNode("只翻译正文"));
  scopeField.append(
    minParagraphLength.wrap,
    contentOnlyRow,
    el("span", "field-hint", "跳过侧栏、小字、图注、面包屑和常见元信息。"),
  );
  element.appendChild(scopeField);

  const glossaryField = el("fieldset", "field-group");
  glossaryField.appendChild(el("legend", undefined, "学习注释"));
  const glossaryRow = el("label", "checkbox-row");
  const glossaryEnabled = el("input", "global-glossaryEnabled global-glossary");
  glossaryEnabled.type = "checkbox";
  glossaryEnabled.checked = settings.glossaryEnabled !== false;
  glossaryRow.append(glossaryEnabled, document.createTextNode("翻译时标出值得学的词"));
  glossaryField.appendChild(glossaryRow);
  glossaryField.appendChild(
    el("span", "field-hint", "每段最多 3 个；悬停查看释义。关闭后只翻译。"),
  );
  element.appendChild(glossaryField);

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
    radio.checked = settings.triggerMode === value;
    option.append(radio, document.createTextNode(label));
    triggerRow.appendChild(option);
    triggerRadios.push(radio);
  }
  triggerField.appendChild(triggerRow);
  element.appendChild(triggerField);

  const saved = el("span", "global-saved translation-saved", "已保存");
  saved.hidden = true;
  const saveButton = makeButton("保存翻译设置", "global-save translation-save");

  saveButton.addEventListener("click", () => {
    void (async () => {
      const current = ctx.getSettings();
      const min = clampInt(
        readNumberOr(minParagraphLength.input.value, current.minParagraphLength),
        4,
        100,
      );
      minParagraphLength.input.value = String(min);
      const triggerMode: TriggerMode =
        triggerRadios.find((radio) => radio.checked)?.value === "auto-current-site"
          ? "auto-current-site"
          : "shortcut";
      saved.textContent = "保存中…";
      saved.hidden = false;
      try {
        await ctx.savePatch({
          targetLang: targetLang.value,
          minParagraphLength: min,
          contentOnly: contentOnly.checked,
          triggerMode,
          glossaryEnabled: glossaryEnabled.checked,
          preference: {
            domain: preferenceDomain.value as DomainPreset,
            instructions: preferenceInstructions.value.trim().slice(0, 500),
          },
        });
        saved.textContent = "已保存";
      } catch {
        saved.textContent = "保存失败";
      }
    })();
  });

  const actions = el("div", "global-actions");
  actions.append(saveButton, saved);
  element.appendChild(actions);

  function summary(): string {
    const current = ctx.getSettings();
    const label =
      TARGET_LANGUAGES.find(([value]) => value === current.targetLang)?.[1] ??
      current.targetLang;
    const trigger = current.triggerMode === "auto-current-site" ? "自动" : "快捷键触发";
    return `${label} · ${trigger}`;
  }

  return {
    id: "translation",
    element,
    summary,
    update(next) {
      targetLang.value = next.targetLang;
      minParagraphLength.input.value = String(next.minParagraphLength);
      contentOnly.checked = next.contentOnly !== false;
      glossaryEnabled.checked = next.glossaryEnabled !== false;
      preferenceDomain.value = next.preference.domain;
      preferenceInstructions.value = next.preference.instructions;
      for (const radio of triggerRadios) {
        radio.checked = radio.value === next.triggerMode;
      }
    },
  };
}
