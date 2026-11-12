import { getLearning } from "../shared/learning-storage";
import { dueCount } from "../shared/srs";

/** Toolbar label: hidden at zero, capped at 99+. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count > 99) return "99+";
  return String(Math.trunc(count));
}

const BADGE_COLOR = "#2dd4bf";

/** Best-effort: a missing `chrome.action` must never break a learning write. */
export async function refreshBadge(now: number = Date.now()): Promise<void> {
  try {
    const state = await getLearning();
    const text = badgeText(dueCount(state.words, now));
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      await chrome.action.setBadgeText({ text });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // Badge is decoration; ignore unavailable APIs and storage failures.
  }
}
