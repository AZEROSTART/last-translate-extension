import { TranslationCache } from "../../background/cache";
import { el, makeButton } from "../components";
import type { SectionHandle, SettingsContext } from "./types";

export function createMaintenanceSection(_ctx: SettingsContext): SectionHandle {
  const element = el("div", "settings-section-content maintenance-section");
  const copy = el(
    "p",
    "settings-copy",
    "清空本地翻译缓存。模型配置和提示词不会受影响。",
  );
  const actions = el("div", "global-actions");
  const clearButton = makeButton("清空翻译缓存", "global-clear-cache");
  const message = el("span", "global-cache-message");
  message.hidden = true;
  actions.append(clearButton, message);
  element.append(copy, actions);

  let armed = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  function resetArm(): void {
    armed = false;
    clearButton.textContent = "清空翻译缓存";
    clearButton.classList.remove("danger");
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  }

  clearButton.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      clearButton.textContent = "确认清空缓存";
      clearButton.classList.add("danger");
      resetTimer = setTimeout(resetArm, 4000);
      return;
    }

    resetArm();
    void (async () => {
      clearButton.disabled = true;
      message.hidden = false;
      message.textContent = "清空中…";
      message.className = "global-cache-message";
      try {
        await new TranslationCache("ilmt").clear();
        message.textContent = "已清空缓存";
        message.className = "global-cache-message success";
      } catch {
        message.textContent = "清空失败";
        message.className = "global-cache-message error";
      } finally {
        clearButton.disabled = false;
      }
    })();
  });

  return {
    id: "maintenance",
    element,
    summary: () => "清理本地翻译缓存",
    update: () => {},
  };
}
