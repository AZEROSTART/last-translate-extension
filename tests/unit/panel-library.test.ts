import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLibraryView, filterLibraryWords } from "../../src/panel/library";
import { mountReview, type ReviewOptions } from "../../src/panel/review";
import {
  deleteWord as deleteWordFromState,
  localDay,
  resetWord as resetWordInState,
  updateWordMeaning,
} from "../../src/shared/learning-storage";
import type {
  LearningState,
  LearningWord,
  UpdateWordMessage,
  UpdateWordResponse,
} from "../../src/shared/types";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function word(index: number, over: Partial<LearningWord> = {}): LearningWord {
  return {
    id: `en:word${index}`,
    termLang: "en",
    surface: `word${index}`,
    glosses: [{ lang: "zh", meaning: `词${index}`, source: "translation", at: NOW }],
    glossLang: "zh",
    contexts: [],
    status: "learning",
    box: 0,
    dueAt: NOW + HOUR,
    createdAt: NOW - index * 1000,
    updatedAt: NOW,
    lastSeenAt: NOW,
    reviews: [],
    reviewsCount: 0,
    correctCount: 0,
    checksSinceSpot: 0,
    ...over,
  };
}

function state(words: LearningWord[], day = ""): LearningState {
  return {
    version: 1,
    words,
    stats: { day, todayReviewed: 0 },
    updatedAt: NOW,
  };
}

function mountLibrary(words: LearningWord[], over: Partial<ReviewOptions> = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let current = state(words);
  const answer = vi.fn().mockResolvedValue({ ok: false });
  const updateWord = vi.fn(async (message: UpdateWordMessage): Promise<UpdateWordResponse> => {
    const next = updateWordMeaning(current, message, NOW);
    if (!next.word) return { ok: false };
    current = next.state;
    return { ok: true, word: next.word };
  });
  const resetWord = vi.fn(async (message: { id: string }) => {
    const next = resetWordInState(current, message.id, NOW);
    if (!next.word) return { ok: false as const };
    current = next.state;
    return { ok: true as const, word: next.word };
  });
  const deleteWord = vi.fn(async (message: { id: string }) => {
    const next = deleteWordFromState(current, message.id, NOW);
    if (!next.deleted) return { ok: false as const };
    current = next.state;
    return { ok: true as const };
  });
  const download = vi.fn();
  const view = mountReview(root, {
    getState: async () => current,
    answer,
    resetWord,
    deleteWord,
    download,
    now: () => NOW,
    updateWord,
    ...over,
  });
  return {
    root,
    view,
    answer,
    updateWord,
    resetWord,
    deleteWord,
    download,
    store: () => current,
  };
}

async function openLibrary(root: HTMLElement): Promise<void> {
  const toggle = root.querySelector<HTMLButtonElement>(".ilmt-review-library-toggle");
  expect(toggle?.textContent).toBe("管理词库");
  toggle!.click();
  expect(root.querySelector(".ilmt-library")).toBeTruthy();
}

function rows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".ilmt-library-item")];
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("library shell", () => {
  it("keeps shelf first, comeback second, toggle third, and hides the toggle when empty", async () => {
    const returning = document.createElement("div");
    document.body.appendChild(returning);
    const store = state(
      [word(1, { dueAt: NOW - HOUR }), word(2, { status: "mastered", dueAt: null })],
      localDay(NOW - 5 * DAY),
    );
    const view2 = mountReview(returning, {
      getState: async () => store,
      now: () => NOW,
    });
    await view2.refresh();

    const shelf = returning.querySelector(".ilmt-review-shelf")!;
    const comeback = returning.querySelector(".ilmt-review-return")!;
    const toggle = returning.querySelector(".ilmt-review-library-toggle")!;
    expect(returning.querySelector(".ilmt-review")!.firstElementChild).toBe(shelf);
    expect(shelf.nextElementSibling).toBe(comeback);
    expect(comeback.nextElementSibling).toBe(toggle);

    await openLibrary(returning);
    const libraryShelf = returning.querySelector(".ilmt-review-shelf")!;
    const libraryComeback = returning.querySelector(".ilmt-review-return")!;
    const libraryToggle =
      returning.querySelector<HTMLButtonElement>(".ilmt-review-library-toggle")!;
    expect(returning.querySelector(".ilmt-review")!.firstElementChild).toBe(libraryShelf);
    expect(libraryShelf.nextElementSibling).toBe(libraryComeback);
    expect(libraryComeback.nextElementSibling).toBe(libraryToggle);
    expect(libraryToggle.textContent).toBe("返回复习");

    libraryToggle.click();
    await vi.waitFor(() => expect(returning.querySelector(".ilmt-library")).toBeNull());
    view2.destroy();

    const empty = document.createElement("div");
    document.body.appendChild(empty);
    const emptyView = mountReview(empty, { getState: async () => state([]), now: () => NOW });
    await emptyView.refresh();
    expect(empty.querySelector(".ilmt-review-done-title")?.textContent).toBe("还没有收录的词");
    expect(empty.querySelector(".ilmt-review-library-toggle")).toBeNull();
    emptyView.destroy();
  });

  it("sorts newest first with a stable id tie-breaker", () => {
    const words = [
      word(1, { id: "en:b", createdAt: 10 }),
      word(2, { id: "en:a", createdAt: 30 }),
      word(3, { id: "en:a2", createdAt: 30 }),
    ];
    expect(filterLibraryWords(words, { filter: "all", query: "" }).map((w) => w.id)).toEqual([
      "en:a",
      "en:a2",
      "en:b",
    ]);
  });
});

describe("filters and search", () => {
  it("filters by status and searches surface or meaning case-insensitively", async () => {
    const { root, view } = mountLibrary([
      word(1, { surface: "Outlive", glosses: [{ lang: "zh", meaning: "比…久", source: "translation", at: NOW }] }),
      word(2, { surface: "actual", glosses: [{ lang: "zh", meaning: "当前的", source: "translation", at: NOW }] }),
      word(3, { surface: "kept", status: "mastered", dueAt: null }),
    ]);
    await view.refresh();
    await openLibrary(root);
    expect(rows(root)).toHaveLength(3);

    const mastered = root.querySelector<HTMLButtonElement>('[data-filter="mastered"]')!;
    mastered.click();
    expect(mastered.getAttribute("aria-pressed")).toBe("true");
    expect(rows(root).map((row) => row.dataset.wordId)).toEqual(["en:word3"]);

    root.querySelector<HTMLButtonElement>('[data-filter="all"]')!.click();
    const search = root.querySelector<HTMLInputElement>(".ilmt-library-search")!;
    search.focus();
    search.value = "OUT";
    search.dispatchEvent(new Event("input"));
    expect(document.activeElement).toBe(search);
    expect(rows(root).map((row) => row.dataset.wordId)).toEqual(["en:word1"]);

    search.value = "当前";
    search.dispatchEvent(new Event("input"));
    expect(document.activeElement).toBe(search);
    expect(rows(root).map((row) => row.dataset.wordId)).toEqual(["en:word2"]);

    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    expect(root.querySelector(".ilmt-library-empty")?.textContent).toBe("没有匹配的词");
    expect(document.activeElement).toBe(search);
    view.destroy();
  });
});

describe("inline editing", () => {
  it("saves, cancels and cancels with Escape without losing the store", async () => {
    const { root, view, updateWord, store } = mountLibrary([
      word(1, { surface: "outlive" }),
    ]);
    await view.refresh();
    await openLibrary(root);

    root.querySelector<HTMLButtonElement>(".ilmt-library-edit")!.click();
    const input = root.querySelector<HTMLInputElement>(".ilmt-library-edit-input")!;
    expect(input.value).toBe("词1");
    const save = root.querySelector<HTMLButtonElement>(".ilmt-library-save")!;

    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    expect(save.disabled).toBe(true);
    input.value = "新的释义";
    input.dispatchEvent(new Event("input"));
    expect(save.disabled).toBe(false);
    save.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-library-meaning")?.textContent).toBe("新的释义");
    });
    expect(updateWord).toHaveBeenCalledWith({
      type: "update-word",
      id: "en:word1",
      meaning: "新的释义",
    });
    expect(store().words[0].glosses[0].meaning).toBe("新的释义");

    root.querySelector<HTMLButtonElement>(".ilmt-library-edit")!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-library-cancel")!.click();
    expect(root.querySelector(".ilmt-library-edit-form")).toBeNull();

    root.querySelector<HTMLButtonElement>(".ilmt-library-edit")!.click();
    const second = root.querySelector<HTMLInputElement>(".ilmt-library-edit-input")!;
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".ilmt-library-edit-form")).toBeNull();
    view.destroy();
  });

  it("surfaces a failed save as an alert and keeps the editor", async () => {
    const { root, view } = mountLibrary([word(1)], {
      updateWord: vi.fn().mockResolvedValue({ ok: false }),
    });
    await view.refresh();
    await openLibrary(root);

    root.querySelector<HTMLButtonElement>(".ilmt-library-edit")!.click();
    const input = root.querySelector<HTMLInputElement>(".ilmt-library-edit-input")!;
    input.value = "失败";
    input.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".ilmt-library-save")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-library-error")?.getAttribute("role")).toBe("alert");
    });
    expect(root.querySelector(".ilmt-library-error")?.textContent).toContain("没保存上");
    expect(root.querySelector(".ilmt-library-edit-form")).toBeTruthy();
    view.destroy();
  });
});

describe("reset and delete", () => {
  it("offers 重新复习 only on mastered rows and re-queues the word on return", async () => {
    const { root, view, store } = mountLibrary([
      word(1, { status: "mastered", box: 5, dueAt: null }),
      word(2),
    ]);
    await view.refresh();
    await openLibrary(root);

    expect(rows(root)[0].querySelector(".ilmt-library-reset")).toBeTruthy();
    expect(rows(root)[1].querySelector(".ilmt-library-reset")).toBeNull();

    rows(root)[0].querySelector<HTMLButtonElement>(".ilmt-library-reset")!.click();
    await vi.waitFor(() => {
      expect(rows(root)[0].querySelector(".ilmt-library-reset")).toBeNull();
    });
    expect(store().words[0]).toMatchObject({ status: "learning", box: 0, dueAt: NOW });

    root.querySelector<HTMLButtonElement>(".ilmt-review-library-toggle")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    });
    view.destroy();
  });

  it("arms one row at a time, exits edit, cancels, and confirms the delete", async () => {
    const { root, view, deleteWord, store } = mountLibrary([word(1), word(2)]);
    await view.refresh();
    await openLibrary(root);

    root.querySelector<HTMLButtonElement>(".ilmt-library-edit")!.click();
    expect(root.querySelector(".ilmt-library-edit-form")).toBeTruthy();

    rows(root)[0].querySelector<HTMLButtonElement>(".ilmt-library-delete")!.click();
    expect(root.querySelector(".ilmt-library-edit-form")).toBeNull();
    expect(root.querySelectorAll(".ilmt-library-confirm-delete")).toHaveLength(1);

    // Arming another row disarms the first.
    rows(root)[1].querySelector<HTMLButtonElement>(".ilmt-library-delete")!.click();
    expect(root.querySelectorAll(".ilmt-library-confirm-delete")).toHaveLength(1);
    expect(rows(root)[1].querySelector(".ilmt-library-confirm-delete")).toBeTruthy();

    rows(root)[1].querySelector<HTMLButtonElement>(".ilmt-library-cancel-delete")!.click();
    expect(root.querySelector(".ilmt-library-confirm-delete")).toBeNull();
    expect(store().words).toHaveLength(2);

    rows(root)[0].querySelector<HTMLButtonElement>(".ilmt-library-delete")!.click();
    rows(root)[0].querySelector<HTMLButtonElement>(".ilmt-library-confirm-delete")!.click();
    await vi.waitFor(() => expect(store().words).toHaveLength(1));
    expect(deleteWord).toHaveBeenCalledWith({ type: "delete-word", id: "en:word1" });
    view.destroy();
  });

  it("returns to the empty review page after deleting the last word", async () => {
    const { root, view, store } = mountLibrary([word(1)]);
    await view.refresh();
    await openLibrary(root);

    root.querySelector<HTMLButtonElement>(".ilmt-library-delete")!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-library-confirm-delete")!.click();

    await vi.waitFor(() => expect(store().words).toHaveLength(0));
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done-title")?.textContent).toBe("还没有收录的词");
    });
    expect(root.querySelector(".ilmt-library")).toBeNull();
    expect(root.querySelector(".ilmt-review-library-toggle")).toBeNull();
    view.destroy();
  });
});

describe("local export", () => {
  it("downloads CSV and JSON with the right filename, MIME and contents", async () => {
    class FakeBlob {
      constructor(
        public parts: string[],
        public options: { type: string },
      ) {}
      get type(): string {
        return this.options.type;
      }
    }
    const createObjectURL = vi.fn((_blob: unknown) => "blob:test");
    const revokeObjectURL = vi.fn();
    const originalBlob = globalThis.Blob;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    vi.stubGlobal("Blob", FakeBlob as unknown as typeof Blob);
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    let downloaded: { name: string; href: string } | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloaded = { name: this.download, href: this.href };
      });

    const root = document.createElement("div");
    document.body.appendChild(root);
    const current = state([word(1, { surface: "outlive" })]);
    const view = mountReview(root, { getState: async () => current, now: () => NOW });
    await view.refresh();
    await openLibrary(root);

    root.querySelector<HTMLButtonElement>('.ilmt-library-export[data-format="csv"]')!.click();
    const csvBlob = createObjectURL.mock.calls[0][0] as unknown as FakeBlob;
    expect(csvBlob.type).toBe("text/csv;charset=utf-8");
    expect(csvBlob.parts[0].startsWith("\uFEFFword,pos,meaning,language,status,sentence,source_url")).toBe(
      true,
    );
    expect(csvBlob.parts[0]).toContain("outlive");
    expect(downloaded).toEqual({
      name: `ilmt-vocabulary-${localDay(NOW)}.csv`,
      href: "blob:test",
    });

    root.querySelector<HTMLButtonElement>('.ilmt-library-export[data-format="json"]')!.click();
    const jsonBlob = createObjectURL.mock.calls[1][0] as unknown as FakeBlob;
    expect(jsonBlob.type).toBe("application/json;charset=utf-8");
    expect(jsonBlob.parts[0]).toContain('"surface": "outlive"');
    expect(downloaded).toEqual({
      name: `ilmt-vocabulary-${localDay(NOW)}.json`,
      href: "blob:test",
    });

    click.mockRestore();
    vi.stubGlobal("Blob", originalBlob);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    view.destroy();
  });
});

describe("keyboard and sources", () => {
  it("ignores every review shortcut while the library is open", async () => {
    const { root, view, answer } = mountLibrary([word(1)]);
    await view.refresh();
    await openLibrary(root);

    for (const value of ["1", "2", " ", "Enter", "z"]) {
      const event = new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented, value).toBe(false);
    }
    expect(root.querySelector(".ilmt-review-lesson")).toBeNull();
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();
    expect(answer).not.toHaveBeenCalled();
    view.destroy();
  });

  it("links only safe sources and falls back to a label", async () => {
    const { root, view } = mountLibrary([
      word(1, {
        surface: "safe",
        contexts: [
          {
            sentence: "A safe sentence.",
            pageUrl: "https://example.test/story",
            pageTitle: "The Story",
            at: NOW,
          },
        ],
      }),
      word(2, {
        surface: "unsafe",
        contexts: [
          {
            sentence: "An unsafe sentence.",
            pageUrl: "javascript:alert(1)",
            pageTitle: "Old Source",
            at: NOW,
          },
        ],
      }),
      word(3, {
        surface: "bare",
        contexts: [
          {
            sentence: "A bare sentence.",
            pageUrl: "https://news.example.test/x",
            at: NOW,
          },
        ],
      }),
    ]);
    await view.refresh();
    await openLibrary(root);

    const safe = rows(root)[0].querySelector<HTMLAnchorElement>(".ilmt-library-source-link")!;
    expect(safe.textContent).toBe("来自：The Story");
    expect(safe.getAttribute("href")).toBe("https://example.test/story");
    expect(safe.target).toBe("_blank");
    expect(safe.rel).toBe("noopener noreferrer");

    expect(rows(root)[1].querySelector(".ilmt-library-source-link")).toBeNull();
    expect(rows(root)[1].querySelector(".ilmt-library-source-label")?.textContent).toBe(
      "来自：Old Source",
    );

    expect(rows(root)[2].querySelector(".ilmt-library-source-link")?.textContent).toBe(
      "来自：news.example.test",
    );
    view.destroy();
  });
});

describe("createLibraryView", () => {
  it("renders an empty note without a state", () => {
    const controller = createLibraryView({
      now: () => NOW,
      preferredLang: () => "",
      updateWord: async () => null,
      resetWord: async () => null,
      deleteWord: async () => null,
      download: () => {},
    });
    controller.sync(state([]));
    expect(controller.element.querySelector(".ilmt-library-empty")?.textContent).toBe(
      "没有匹配的词",
    );
  });
});
