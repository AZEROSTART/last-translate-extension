import type { EffectSettings, Settings } from "../../shared/types";
import { LEARNING_LANGS, normalizeLearningLangs } from "../../shared/storage";
import { getEffects } from "../../content/effects";
import type { ClaimEffect } from "../../content/effects/types";
import "../../content/effects/gopher-hole";
import { el, makeButton } from "../components";
import type { SectionHandle, SettingsContext } from "./types";

const LEARNING_LANG_LABELS: Record<string, string> = {
  en: "英语",
  ja: "日语",
  es: "西班牙语",
  fr: "法语",
};

const ANSWER_LANGUAGES: Array<[string, string]> = [
  ["", "跟随目标语言"],
  ["zh-CN", "简体中文"],
  ["en", "英语"],
  ["ja", "日语"],
  ["es", "西班牙语"],
  ["fr", "法语"],
];

/**
 * Mount a throwaway effect on a stand-in word. The claim is a local stub so the
 * settings page can never write to the learning store.
 */
function mountEffectPreview(
  slot: HTMLElement,
  effect: ClaimEffect,
  animations: boolean,
): { cleanup: () => void } {
  const surface = el("span", "effect-preview-word", "outlive");
  const host = el("div", "effect-preview-host");
  const line = el("div", "effect-preview-line");
  line.append(surface, host);
  if (effect.reserve.above > 0) line.style.paddingTop = `${effect.reserve.above}px`;
  if (effect.reserve.below > 0) line.style.marginBottom = `${effect.reserve.below}px`;
  slot.replaceChildren(line);

  const style = document.createElement("style");
  style.dataset.ilmtEffects = "";
  style.textContent = getEffects()
    .map((item) => item.css ?? "")
    .join("\n");
  document.head.appendChild(style);

  const handle = effect.mount({
    doc: document,
    surface,
    root: host,
    theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    animations,
    claim: async () => ({ ok: true, created: true }),
    announce: () => {},
    label: (verb) => `把${effect.label}${verb}下去，收录这个词`,
  });

  return {
    cleanup: () => {
      handle.destroy();
      style.remove();
      slot.replaceChildren();
    },
  };
}

export function createLearningSection(ctx: SettingsContext): SectionHandle {
  const element = el("div", "settings-section-content learning-section");
  const settings = ctx.getSettings();

  const goals = el("fieldset", "field-group learning-goals");
  goals.appendChild(el("legend", undefined, "学习目标"));
  const boxes = new Map<string, HTMLInputElement>();
  for (const lang of LEARNING_LANGS) {
    const row = el("label", "checkbox-row");
    const box = el("input", "global-learningLang");
    box.type = "checkbox";
    box.value = lang;
    box.dataset.lang = lang;
    box.checked = settings.learningLangs.includes(lang);
    row.append(box, document.createTextNode(LEARNING_LANG_LABELS[lang] ?? lang));
    goals.appendChild(row);
    boxes.set(lang, box);
  }
  goals.appendChild(
    el("span", "field-hint", "勾选的语言会让这些页面的词出现在注释与复习里；至少保留一种。"),
  );
  element.appendChild(goals);

  const effectField = el("fieldset", "field-group effect-settings");
  effectField.appendChild(el("legend", undefined, "收录特效"));

  const enabledBoxes = new Map<string, HTMLInputElement>();
  const registered = getEffects();
  const enabledAtBoot =
    settings.mascot.enabledIds.length > 0
      ? new Set(settings.mascot.enabledIds)
      : new Set(registered.map((effect) => effect.id));

  // 先建动效开关，特效行的「试一试」要读它的当前值
  const animateRow = el("label", "checkbox-row");
  const mascotAnimations = el("input", "global-mascot-animations");
  mascotAnimations.type = "checkbox";
  mascotAnimations.checked = settings.mascot.animations !== false;
  animateRow.append(mascotAnimations, document.createTextNode("播放收录动效"));

  let preview: { cleanup: () => void } | null = null;

  const closePreview = (): void => {
    preview?.cleanup();
    preview = null;
    for (const slot of effectField.querySelectorAll<HTMLElement>(".effect-preview")) {
      slot.hidden = true;
      slot.replaceChildren();
    }
  };

  for (const effect of registered) {
    const row = el("div", "effect-row");
    const label = el("label", "checkbox-row effect-toggle");
    const box = el("input", "global-effect-enabled");
    box.type = "checkbox";
    box.value = effect.id;
    box.dataset.effect = effect.id;
    box.checked = enabledAtBoot.has(effect.id);
    enabledBoxes.set(effect.id, box);
    label.append(box, document.createTextNode(effect.label));
    row.appendChild(label);
    row.appendChild(el("span", "effect-summary", effect.summary));

    const tryButton = makeButton("试一试", "ghost-button effect-try");
    tryButton.dataset.effect = effect.id;
    const slot = el("div", "effect-preview");
    slot.hidden = true;
    tryButton.addEventListener("click", () => {
      const alreadyOpen = !slot.hidden;
      closePreview();
      if (alreadyOpen) return;
      slot.hidden = false;
      preview = mountEffectPreview(slot, effect, mascotAnimations.checked);
    });

    row.append(tryButton, slot);
    effectField.appendChild(row);
  }

  effectField.appendChild(
    el(
      "span",
      "field-hint",
      "勾选的特效会参与随机轮换；至少保留一个。设置页的「试一试」不会写入学习库。",
    ),
  );

  const modeField = el("label", "field");
  modeField.appendChild(el("span", "field-label", "选择方式"));
  const mascotMode = el("select", "global-mascot-mode");
  for (const [value, text] of [
    ["rotate", "随机轮换"],
    ["fixed", "固定为"],
  ] as Array<[EffectSettings["mode"], string]>) {
    const option = el("option");
    option.value = value;
    option.textContent = text;
    mascotMode.appendChild(option);
  }
  mascotMode.value = settings.mascot.mode;
  modeField.appendChild(mascotMode);
  effectField.appendChild(modeField);

  const fixedField = el("label", "field");
  fixedField.appendChild(el("span", "field-label", "固定特效"));
  const mascotFixed = el("select", "global-mascot-fixed");
  fixedField.appendChild(mascotFixed);
  fixedField.hidden = settings.mascot.mode !== "fixed";
  effectField.appendChild(fixedField);

  const rebuildFixedOptions = (): void => {
    const previous = mascotFixed.value || settings.mascot.fixedId || "";
    mascotFixed.replaceChildren();
    const usable = registered.filter((effect) => enabledBoxes.get(effect.id)?.checked);
    for (const effect of usable) {
      const option = el("option");
      option.value = effect.id;
      option.textContent = effect.label;
      mascotFixed.appendChild(option);
    }
    mascotFixed.value = usable.some((effect) => effect.id === previous)
      ? previous
      : (usable[0]?.id ?? "");
    fixedField.hidden = mascotMode.value !== "fixed";
  };
  rebuildFixedOptions();
  mascotMode.addEventListener("change", () => {
    closePreview();
    rebuildFixedOptions();
  });

  effectField.appendChild(animateRow);

  for (const box of enabledBoxes.values()) {
    box.addEventListener("change", () => {
      closePreview();
      rebuildFixedOptions();
    });
  }

  element.appendChild(effectField);

  const answerField = el("label", "field");
  answerField.appendChild(el("span", "field-label", "复习答案语言"));
  const reviewAnswerLang = el("select", "global-review-answer-lang");
  for (const [value, label] of ANSWER_LANGUAGES) {
    const option = el("option");
    option.value = value;
    option.textContent = label;
    reviewAnswerLang.appendChild(option);
  }
  if (!Array.from(reviewAnswerLang.options).some((option) => option.value === settings.reviewAnswerLang)) {
    const custom = el("option");
    custom.value = settings.reviewAnswerLang ?? "";
    custom.textContent = settings.reviewAnswerLang || "跟随目标语言";
    reviewAnswerLang.appendChild(custom);
  }
  reviewAnswerLang.value = settings.reviewAnswerLang ?? "";
  answerField.appendChild(reviewAnswerLang);
  element.appendChild(answerField);

  const directionField = el("fieldset", "field-group");
  directionField.appendChild(el("legend", undefined, "复习方向"));
  const directionRow = el("label", "checkbox-row");
  const direction = el("input", "global-review-direction");
  direction.type = "checkbox";
  direction.checked = true;
  direction.disabled = true;
  directionRow.append(direction, document.createTextNode("认词 → 释义"));
  directionField.append(directionRow, el("span", "field-hint", "反向复习即将支持。"));
  element.appendChild(directionField);

  const saved = el("span", "global-saved learning-saved", "已保存");
  saved.hidden = true;
  const saveButton = makeButton("保存学习设置", "global-save learning-save");

  saveButton.addEventListener("click", () => {
    void (async () => {
      const chosen = LEARNING_LANGS.filter((lang) => boxes.get(lang)?.checked);
      const enabledIds = [...enabledBoxes.entries()]
        .filter(([, box]) => box.checked)
        .map(([id]) => id);
      if (enabledIds.length === 0) {
        saved.textContent = "至少启用一个特效";
        saved.hidden = false;
        return;
      }
      const mode: EffectSettings["mode"] = mascotMode.value === "fixed" ? "fixed" : "rotate";
      saved.textContent = "保存中…";
      saved.hidden = false;
      try {
        await ctx.savePatch({
          learningLangs: normalizeLearningLangs(chosen),
          mascot: {
            mode,
            ...(mode === "fixed" && mascotFixed.value ? { fixedId: mascotFixed.value } : {}),
            enabledIds,
            animations: mascotAnimations.checked,
          },
          reviewAnswerLang: reviewAnswerLang.value,
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
    const langs = current.learningLangs
      .map((lang) => LEARNING_LANG_LABELS[lang] ?? lang)
      .join(" · ");
    return `${langs || "英语"} · ${current.mascot.mode === "fixed" ? "固定特效" : "随机轮换"}`;
  }

  return {
    id: "learning",
    element,
    summary,
    update(next: Settings) {
      for (const lang of LEARNING_LANGS) {
        const box = boxes.get(lang);
        if (box) box.checked = next.learningLangs.includes(lang);
      }
      mascotMode.value = next.mascot.mode;
      for (const [id, box] of enabledBoxes) {
        box.checked =
          next.mascot.enabledIds.length === 0
            ? true
            : next.mascot.enabledIds.includes(id);
      }
      closePreview();
      rebuildFixedOptions();
      const fixedId = next.mascot.fixedId;
      if (fixedId && Array.from(mascotFixed.options).some((option) => option.value === fixedId)) {
        mascotFixed.value = fixedId;
      }
      saveButton.disabled = false;
      fixedField.hidden = next.mascot.mode !== "fixed";
      mascotAnimations.checked = next.mascot.animations !== false;
      reviewAnswerLang.value = next.reviewAnswerLang ?? "";
    },
  };
}
