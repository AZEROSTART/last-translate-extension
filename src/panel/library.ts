/**
 * The personal vocabulary library: the same store as review, but browsable.
 * Its toolbar is built once and the list is replaced under it, so typing in the
 * search box never loses focus — not even when storage syncs underneath.
 */

import { formatDueLabel } from "../shared/srs";
import {
  primaryMeaning,
  safeHttpUrl,
  urlHostname,
} from "../shared/learning-storage";
import type { LearningState, LearningWord } from "../shared/types";

export type LibraryFilter = "all" | "learning" | "mastered";

export interface LibraryQuery {
  filter: LibraryFilter;
  query: string;
}

/** Newest first, with a stable id tie-break, after status and text filtering. */
export function filterLibraryWords(
  words: readonly LearningWord[],
  { filter, query }: LibraryQuery,
): LearningWord[] {
  const needle = query.trim().toLocaleLowerCase();
  return words
    .filter((word) => filter === "all" || word.status === filter)
    .filter(
      (word) =>
        !needle ||
        word.surface.toLocaleLowerCase().includes(needle) ||
        word.glosses.some((gloss) => gloss.meaning.toLocaleLowerCase().includes(needle)),
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export interface LibraryViewOptions {
  now(): number;
  preferredLang(): string;
  updateWord(id: string, meaning: string): Promise<LearningState | null>;
  resetWord(id: string): Promise<LearningState | null>;
  deleteWord(id: string): Promise<LearningState | null>;
  download(format: "csv" | "json"): void;
}

export interface LibraryController {
  element: HTMLElement;
  sync(state: LearningState): void;
  resetTransient(): void;
}

const FILTERS: Array<[LibraryFilter, string]> = [
  ["all", "全部"],
  ["learning", "学习中"],
  ["mastered", "已毕业"],
];

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function statusLabel(word: LearningWord, now: number): string {
  if (word.status === "mastered") return "已毕业";
  if (word.dueAt === null || word.dueAt <= now) return "已到期";
  return formatDueLabel(word.dueAt, now);
}

export function createLibraryView(options: LibraryViewOptions): LibraryController {
  const element = node("div", "ilmt-library");
  const toolbar = node("div", "ilmt-library-toolbar");
  const filters = node("div", "ilmt-library-filters");
  const search = node("input", "ilmt-library-search");
  const exports = node("div", "ilmt-library-exports");
  const list = node("div", "ilmt-library-list");

  let all: LearningState | null = null;
  let filter: LibraryFilter = "all";
  let query = "";
  let editingId: string | null = null;
  let confirmingId: string | null = null;
  let errorId: string | null = null;
  let errorText = "";
  let mutatingId: string | null = null;

  const filterButtons: HTMLButtonElement[] = [];
  for (const [value, label] of FILTERS) {
    const button = node("button", "ilmt-library-filter", label);
    button.type = "button";
    button.dataset.filter = value;
    button.setAttribute("aria-pressed", String(value === filter));
    button.addEventListener("click", () => {
      filter = value;
      renderToolbarState();
      renderList();
    });
    filterButtons.push(button);
    filters.appendChild(button);
  }

  search.type = "search";
  search.placeholder = "搜索单词或释义";
  search.setAttribute("aria-label", "搜索词库");
  search.autocomplete = "off";
  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });

  for (const [format, label] of [
    ["csv", "导出 CSV"],
    ["json", "导出 JSON"],
  ] as const) {
    const button = node("button", "ilmt-library-export", label);
    button.type = "button";
    button.dataset.format = format;
    button.addEventListener("click", () => options.download(format));
    exports.appendChild(button);
  }

  toolbar.append(filters, search, exports);
  element.append(toolbar, list);

  function renderToolbarState(): void {
    for (const button of filterButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
    }
  }

  function setError(id: string, message: string): void {
    errorId = id;
    errorText = message;
  }

  function clearError(): void {
    errorId = null;
    errorText = "";
  }

  function beginEdit(word: LearningWord): void {
    editingId = word.id;
    confirmingId = null;
    clearError();
    renderList();
    const input = list.querySelector<HTMLInputElement>(".ilmt-library-edit-input");
    input?.focus();
    input?.select();
  }

  function cancelEdit(): void {
    editingId = null;
    clearError();
    renderList();
  }

  async function saveEdit(word: LearningWord, input: HTMLInputElement): Promise<void> {
    const meaning = input.value.trim();
    if (!meaning || mutatingId) return;
    mutatingId = word.id;
    clearError();
    const next = await options.updateWord(word.id, meaning);
    mutatingId = null;
    if (!next) {
      setError(word.id, "没保存上 · 再试一次");
      renderList();
      return;
    }
    all = next;
    editingId = null;
    renderList();
  }

  async function reset(word: LearningWord): Promise<void> {
    if (mutatingId) return;
    mutatingId = word.id;
    clearError();
    const next = await options.resetWord(word.id);
    mutatingId = null;
    if (!next) {
      setError(word.id, "没重置成功 · 再试一次");
      renderList();
      return;
    }
    all = next;
    renderList();
  }

  async function remove(word: LearningWord): Promise<void> {
    if (mutatingId) return;
    mutatingId = word.id;
    clearError();
    const next = await options.deleteWord(word.id);
    mutatingId = null;
    if (!next) {
      setError(word.id, "没删掉 · 再试一次");
      renderList();
      return;
    }
    all = next;
    confirmingId = null;
    editingId = null;
    renderList();
  }

  function renderEditForm(word: LearningWord): HTMLElement {
    const form = node("form", "ilmt-library-edit-form");
    const input = node("input", "ilmt-library-edit-input");
    input.type = "text";
    input.setAttribute("aria-label", "修改释义");
    input.value = primaryMeaning(word, options.preferredLang());
    const save = node("button", "ilmt-library-save", "保存");
    save.type = "submit";
    save.disabled = !input.value.trim();
    input.addEventListener("input", () => {
      save.disabled = !input.value.trim();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelEdit();
    });
    const cancel = node("button", "ilmt-library-cancel", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", cancelEdit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      void saveEdit(word, input);
    });
    form.append(input, save, cancel);
    return form;
  }

  function renderSource(word: LearningWord): HTMLElement | null {
    const context = word.contexts.at(-1);
    if (!context) return null;
    const safeUrl = safeHttpUrl(context.pageUrl ?? "");
    const label = context.pageTitle?.trim() || (safeUrl ? urlHostname(safeUrl) : "");
    const source = node("div", "ilmt-library-source");
    if (safeUrl) {
      const link = node("a", "ilmt-library-source-link", `来自：${label}`);
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = label;
      source.appendChild(link);
    } else if (label) {
      const span = node("span", "ilmt-library-source-label", `来自：${label}`);
      span.title = label;
      source.appendChild(span);
    }
    return source.childElementCount > 0 ? source : null;
  }

  function renderActions(word: LearningWord): HTMLElement {
    const actions = node("div", "ilmt-library-item-actions");
    const busy = mutatingId === word.id;

    if (confirmingId === word.id) {
      const confirm = node("button", "ilmt-library-confirm-delete", "确认删除");
      confirm.type = "button";
      confirm.disabled = busy;
      confirm.addEventListener("click", () => void remove(word));
      const cancel = node("button", "ilmt-library-cancel-delete", "取消");
      cancel.type = "button";
      cancel.disabled = busy;
      cancel.addEventListener("click", () => {
        confirmingId = null;
        clearError();
        renderList();
      });
      actions.append(confirm, cancel);
      return actions;
    }

    const edit = node("button", "ilmt-library-edit", "编辑");
    edit.type = "button";
    edit.disabled = busy;
    edit.addEventListener("click", () => beginEdit(word));
    actions.appendChild(edit);

    if (word.status === "mastered") {
      const resetButton = node("button", "ilmt-library-reset", "重新复习");
      resetButton.type = "button";
      resetButton.disabled = busy;
      resetButton.addEventListener("click", () => void reset(word));
      actions.appendChild(resetButton);
    }

    const removeButton = node("button", "ilmt-library-delete", "删除");
    removeButton.type = "button";
    removeButton.disabled = busy;
    removeButton.addEventListener("click", () => {
      // Only one row may be armed, and confirming never coexists with an edit.
      confirmingId = word.id;
      editingId = null;
      clearError();
      renderList();
    });
    actions.appendChild(removeButton);
    return actions;
  }

  function renderItem(word: LearningWord): HTMLElement {
    const item = node("div", "ilmt-library-item");
    item.dataset.wordId = word.id;

    const head = node("div", "ilmt-library-head");
    head.appendChild(node("span", "ilmt-library-word", word.surface));
    if (word.pos) head.appendChild(node("span", "ilmt-library-pos", word.pos));
    head.appendChild(node("span", "ilmt-library-status", statusLabel(word, options.now())));
    item.appendChild(head);

    if (editingId === word.id) {
      item.appendChild(renderEditForm(word));
    } else {
      const meaning = primaryMeaning(word, options.preferredLang());
      const line = node("p", "ilmt-library-meaning", meaning || "释义还没生成");
      if (!meaning) line.classList.add("is-placeholder");
      item.appendChild(line);
    }

    const source = renderSource(word);
    if (source) item.appendChild(source);

    item.appendChild(renderActions(word));

    if (errorId === word.id && errorText) {
      const error = node("p", "ilmt-library-error", errorText);
      error.setAttribute("role", "alert");
      item.appendChild(error);
    }
    return item;
  }

  function renderList(): void {
    list.replaceChildren();
    if (!all) return;
    const words = filterLibraryWords(all.words, { filter, query });
    if (words.length === 0) {
      list.appendChild(node("p", "ilmt-library-empty", "没有匹配的词"));
      return;
    }
    for (const word of words) list.appendChild(renderItem(word));
  }

  return {
    element,
    sync(state: LearningState): void {
      all = state;
      if (editingId && !state.words.some((word) => word.id === editingId)) editingId = null;
      if (confirmingId && !state.words.some((word) => word.id === confirmingId)) {
        confirmingId = null;
      }
      if (errorId && !state.words.some((word) => word.id === errorId)) {
        errorId = null;
        errorText = "";
      }
      renderToolbarState();
      renderList();
    },
    resetTransient(): void {
      editingId = null;
      confirmingId = null;
      mutatingId = null;
      clearError();
      renderList();
    },
  };
}
