import {
  clampInt,
  el,
  makeButton,
  makeNumberControl,
  readNumberOr,
} from "../components";
import type { SectionHandle, SettingsContext } from "./types";

export function createAdvancedSection(ctx: SettingsContext): SectionHandle {
  const element = el("div", "settings-section-content advanced-section");
  const settings = ctx.getSettings();

  const numericGrid = el("div", "field-grid");
  const concurrency = makeNumberControl(
    "并发上限",
    "global-concurrency",
    settings.concurrency,
    1,
    10,
    1,
    "同时进行的请求数",
  );
  const maxRPS = makeNumberControl(
    "每秒请求上限",
    "global-maxRPS",
    settings.maxRPS,
    1,
    20,
    1,
    "每秒最多发起的请求数",
  );
  const temperature = makeNumberControl(
    "温度",
    "global-temperature",
    settings.temperature,
    undefined,
    undefined,
    0.1,
    "0 表示输出更稳定",
  );
  numericGrid.append(concurrency.wrap, maxRPS.wrap, temperature.wrap);
  element.appendChild(numericGrid);

  const saved = el("span", "global-saved advanced-saved", "已保存");
  saved.hidden = true;
  const saveButton = makeButton("保存高级设置", "global-save advanced-save");

  saveButton.addEventListener("click", () => {
    void (async () => {
      const current = ctx.getSettings();
      const nextConcurrency = clampInt(
        readNumberOr(concurrency.input.value, current.concurrency),
        1,
        10,
      );
      const nextMaxRPS = clampInt(readNumberOr(maxRPS.input.value, current.maxRPS), 1, 20);
      const nextTemperature = readNumberOr(temperature.input.value, current.temperature);
      concurrency.input.value = String(nextConcurrency);
      maxRPS.input.value = String(nextMaxRPS);
      temperature.input.value = String(nextTemperature);
      saved.textContent = "保存中…";
      saved.hidden = false;
      try {
        await ctx.savePatch({
          concurrency: nextConcurrency,
          maxRPS: nextMaxRPS,
          temperature: nextTemperature,
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
    return `并发 ${current.concurrency} · RPS ${current.maxRPS} · 温度 ${current.temperature}`;
  }

  return {
    id: "advanced",
    element,
    summary,
    update(next) {
      concurrency.input.value = String(next.concurrency);
      maxRPS.input.value = String(next.maxRPS);
      temperature.input.value = String(next.temperature);
    },
  };
}
