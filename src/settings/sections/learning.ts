import type { MascotSettings, Settings } from "../../shared/types";
import { LEARNING_LANGS, normalizeLearningLangs } from "../../shared/storage";
import { getMascots } from "../../content/mascots";
import "../../content/mascots/gopher";
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

  const mascotField = el("fieldset", "field-group mascot-settings");
  mascotField.appendChild(el("legend", undefined, "认领角色"));

  const modeField = el("label", "field");
  modeField.appendChild(el("span", "field-label", "选择方式"));
  const mascotMode = el("select", "global-mascot-mode");
  for (const [value, label] of [
    ["rotate", "随机轮换"],
    ["fixed", "固定为"],
  ] as Array<[MascotSettings["mode"], string]>) {
    const option = el("option");
    option.value = value;
    option.textContent = label;
    mascotMode.appendChild(option);
  }
  mascotMode.value = settings.mascot.mode;
  modeField.appendChild(mascotMode);
  mascotField.appendChild(modeField);

  const fixedField = el("label", "field");
  fixedField.appendChild(el("span", "field-label", "固定角色"));
  const mascotFixed = el("select", "global-mascot-fixed");
  for (const skin of getMascots()) {
    const option = el("option");
    option.value = skin.id;
    option.textContent = skin.label;
    mascotFixed.appendChild(option);
  }
  mascotFixed.value = settings.mascot.fixedId ?? getMascots()[0]?.id ?? "";
  fixedField.appendChild(mascotFixed);
  fixedField.hidden = settings.mascot.mode !== "fixed";
  mascotField.appendChild(fixedField);

  const animateRow = el("label", "checkbox-row");
  const mascotAnimations = el("input", "global-mascot-animations");
  mascotAnimations.type = "checkbox";
  mascotAnimations.checked = settings.mascot.animations !== false;
  animateRow.append(mascotAnimations, document.createTextNode("播放角色动效"));
  mascotField.appendChild(animateRow);
  element.appendChild(mascotField);

  mascotMode.addEventListener("change", () => {
    fixedField.hidden = mascotMode.value !== "fixed";
  });

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
      const current = ctx.getSettings();
      const chosen = LEARNING_LANGS.filter((lang) => boxes.get(lang)?.checked);
      const mode: MascotSettings["mode"] = mascotMode.value === "fixed" ? "fixed" : "rotate";
      saved.textContent = "保存中…";
      saved.hidden = false;
      try {
        await ctx.savePatch({
          learningLangs: normalizeLearningLangs(chosen),
          mascot: {
            mode,
            ...(mode === "fixed" && mascotFixed.value ? { fixedId: mascotFixed.value } : {}),
            enabledIds: [...current.mascot.enabledIds],
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
    return `${langs || "英语"} · ${current.mascot.mode === "fixed" ? "固定角色" : "随机轮换"}`;
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
      fixedField.hidden = next.mascot.mode !== "fixed";
      if (next.mascot.fixedId) mascotFixed.value = next.mascot.fixedId;
      mascotAnimations.checked = next.mascot.animations !== false;
      reviewAnswerLang.value = next.reviewAnswerLang ?? "";
    },
  };
}
