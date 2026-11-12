/**
 * Side-panel review view: one due word at a time, self-assessment, and an
 * optional answer language. Scheduling lives in `shared/srs.ts`; this module
 * only renders a queue and forwards grades to the background.
 *
 * The chat view and this view never share state; `main.ts` mounts this into
 * its own container and keeps the conversation alive while review is open.
 */

import { getLearning } from "../shared/learning-storage";
import { dueCount } from "../shared/srs";
import type {
  LearningGrade,
  LearningState,
  LearningWord,
  ReviewAnswerMessage,
  ReviewAnswerResponse,
} from "../shared/types";
import { getMascot, type MascotSkin } from "../content/mascots";
import "../content/mascots/gopher";

const TERM_LANG_KEY = "ilmt:review-lang";
const GLOSS_LANG_KEY = "ilmt:review-gloss-lang";
const ALL = "all";

const LANG_LABELS: Record<string, string> = {
  en: "英语",
  es: "西语",
  ja: "日语",
  fr: "法语",
  de: "德语",
  zh: "中文",
};

function langPrefix(lang: string): string {
  return lang.split(/[-_]/)[0].trim().toLowerCase();
}

function langLabel(lang: string): string {
  return LANG_LABELS[langPrefix(lang)] ?? lang;
}

function readSession(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private mode: the choice simply does not persist.
  }
}

export interface ReviewDeps {
  getState(): Promise<LearningState>;
  answer(message: ReviewAnswerMessage): Promise<ReviewAnswerResponse>;
  mascot(id?: string): MascotSkin | undefined;
  now(): number;
}

/** Due cards only, oldest due first, optionally narrowed to one word language. */
export function buildReviewQueue(
  state: LearningState,
  opts: { termLang: string | "all"; now: number },
): LearningWord[] {
  return state.words
    .filter(
      (word) =>
        word.status === "learning" &&
        word.dueAt !== null &&
        word.dueAt <= opts.now &&
        (opts.termLang === ALL || word.termLang === opts.termLang),
    )
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.createdAt - b.createdAt);
}

async function defaultAnswer(message: ReviewAnswerMessage): Promise<ReviewAnswerResponse> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return (response ?? { ok: false }) as ReviewAnswerResponse;
  } catch {
    return { ok: false } as unknown as ReviewAnswerResponse;
  }
}

function defaultMascot(id?: string): MascotSkin | undefined {
  return getMascot(id ?? "") ?? getMascot("gopher");
}

export interface ReviewView {
  refresh(): Promise<void>;
  destroy(): void;
}

interface ReviewState {
  all: LearningState | null;
  queue: LearningWord[];
  total: number;
  answered: number;
  correct: number;
  revealed: boolean;
  termLang: string;
  glossLang: string;
  busy: boolean;
}

export function mountReview(target: HTMLElement, over: Partial<ReviewDeps> = {}): ReviewView {
  const deps: ReviewDeps = {
    getState: over.getState ?? (() => getLearning()),
    answer: over.answer ?? defaultAnswer,
    mascot: over.mascot ?? defaultMascot,
    now: over.now ?? (() => Date.now()),
  };

  const container = document.createElement("div");
  container.className = "ilmt-review";
  target.appendChild(container);

  const state: ReviewState = {
    all: null,
    queue: [],
    total: 0,
    answered: 0,
    correct: 0,
    revealed: false,
    termLang: readSession(TERM_LANG_KEY) || ALL,
    glossLang: readSession(GLOSS_LANG_KEY),
    busy: false,
  };

  let destroyed = false;
  let chain: Promise<void> = Promise.resolve();
  let pendingReload = false;

  function current(): LearningWord | undefined {
    return state.queue[0];
  }

  function blankedSentence(word: LearningWord): { blanked: string; full: string } {
    const full = word.contexts.at(-1)?.sentence?.trim() || word.surface;
    const escaped = word.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blanked = escaped ? full.replace(new RegExp(escaped, "gi"), "____") : full;
    return { blanked, full };
  }

  function renderFilters(): HTMLElement[] {
    const words = state.all?.words ?? [];
    const langs = [...new Set(words.map((word) => word.termLang))];
    const nodes: HTMLElement[] = [];

    if (langs.length >= 2) {
      const chips = document.createElement("div");
      chips.className = "ilmt-review-langs";
      const options = [ALL, ...langs];
      for (const lang of options) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "ilmt-review-lang";
        chip.dataset.lang = lang;
        const count =
          lang === ALL
            ? dueCount(words, deps.now())
            : words.filter(
                (word) =>
                  word.termLang === lang &&
                  word.status === "learning" &&
                  word.dueAt !== null &&
                  word.dueAt <= deps.now(),
              ).length;
        chip.textContent = `${lang === ALL ? "全部" : langLabel(lang)} ${count}`;
        if (state.termLang === lang) chip.classList.add("is-active");
        chip.setAttribute("aria-pressed", String(state.termLang === lang));
        chip.addEventListener("click", () => {
          state.termLang = lang;
          writeSession(TERM_LANG_KEY, lang);
          state.answered = 0;
          state.correct = 0;
          state.revealed = false;
          void refresh();
        });
        chips.appendChild(chip);
      }
      nodes.push(chips);
    }

    const glossLangs = [
      ...new Set(words.flatMap((word) => word.glosses.map((gloss) => gloss.lang))),
    ];
    if (glossLangs.length >= 2) {
      const wrap = document.createElement("label");
      wrap.className = "ilmt-review-gloss";
      const text = document.createElement("span");
      text.textContent = "答案语言";
      const select = document.createElement("select");
      select.className = "ilmt-review-gloss-lang";
      select.setAttribute("aria-label", "答案语言");
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "按单词默认";
      select.appendChild(auto);
      for (const lang of glossLangs) {
        const option = document.createElement("option");
        option.value = lang;
        option.textContent = langLabel(lang);
        select.appendChild(option);
      }
      select.value = state.glossLang;
      select.addEventListener("change", () => {
        state.glossLang = select.value;
        writeSession(GLOSS_LANG_KEY, select.value);
        render();
      });
      wrap.append(text, select);
      nodes.push(wrap);
    }

    return nodes;
  }

  function renderAnswer(word: LearningWord, card: HTMLElement): void {
    if (!state.revealed) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "ilmt-review-reveal";
      reveal.textContent = "想不起来，看答案";
      reveal.addEventListener("click", () => {
        state.revealed = true;
        render();
      });
      card.appendChild(reveal);
      return;
    }

    const primaryLang = state.glossLang || word.glossLang;
    const primary =
      word.glosses.find((gloss) => gloss.lang === primaryLang) ??
      word.glosses.find((gloss) => gloss.lang === word.glossLang) ??
      word.glosses[0];
    const rest = word.glosses.filter((gloss) => gloss !== primary);

    const answer = document.createElement("div");
    answer.className = "ilmt-review-answer";

    const meaning = document.createElement("div");
    meaning.className = "ilmt-review-meaning";
    if (primary) {
      meaning.textContent = primary.meaning;
    } else {
      meaning.textContent = `${langLabel(primaryLang)}释义尚未生成`;
      meaning.classList.add("is-placeholder");
    }
    answer.appendChild(meaning);

    if (rest.length > 0) {
      const more = document.createElement("div");
      more.className = "ilmt-review-meaning-more";
      more.textContent = rest.map((gloss) => `${langLabel(gloss.lang)} · ${gloss.meaning}`).join("　");
      answer.appendChild(more);
    }

    const { full } = blankedSentence(word);
    const fullSentence = document.createElement("p");
    fullSentence.className = "ilmt-review-sentence-full";
    fullSentence.textContent = full;
    answer.appendChild(fullSentence);

    card.appendChild(answer);
  }

  function renderCard(): void {
    const card = document.createElement("div");
    card.className = "ilmt-review-card";
    const word = current();
    if (!word) return;

    const head = document.createElement("div");
    head.className = "ilmt-review-head";
    const progress = document.createElement("span");
    progress.className = "ilmt-review-progress";
    progress.textContent = `${state.answered + 1} / ${state.total}`;
    const end = document.createElement("button");
    end.type = "button";
    end.className = "ilmt-review-end";
    end.textContent = "结束";
    end.addEventListener("click", () => {
      state.queue = [];
      state.revealed = false;
      render();
    });
    head.append(progress, end);
    card.appendChild(head);

    const skin = deps.mascot(word.mascotId);
    if (skin) {
      const mascot = document.createElement("div");
      mascot.className = "ilmt-review-mascot";
      try {
        mascot.appendChild(skin.render("idle", currentTheme()));
      } catch {
        // A broken skin is decoration only; never block a review.
      }
      card.appendChild(mascot);
    }

    const term = document.createElement("div");
    term.className = "ilmt-review-term";
    const surface = document.createElement("span");
    surface.className = "ilmt-review-word";
    surface.textContent = word.surface;
    term.appendChild(surface);
    if (word.pos) {
      const pos = document.createElement("span");
      pos.className = "ilmt-review-pos";
      pos.textContent = word.pos;
      term.appendChild(pos);
    }
    const lang = document.createElement("span");
    lang.className = "ilmt-review-lang-label";
    lang.textContent = langLabel(word.termLang);
    term.appendChild(lang);
    card.appendChild(term);

    const { blanked } = blankedSentence(word);
    const sentence = document.createElement("p");
    sentence.className = "ilmt-review-sentence";
    sentence.textContent = blanked;
    card.appendChild(sentence);

    renderAnswer(word, card);

    const grades = document.createElement("div");
    grades.className = "ilmt-review-grades";
    const buttons: Array<[LearningGrade, string]> = [
      ["again", "忘了"],
      ["hard", "模糊"],
      ["good", "认识"],
    ];
    for (const [grade, label] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ilmt-review-grade";
      button.dataset.grade = grade;
      button.textContent = label;
      button.disabled = state.busy;
      button.addEventListener("click", () => void submit(grade));
      grades.appendChild(button);
    }
    card.appendChild(grades);

    container.appendChild(card);
  }

  function renderFinish(): void {
    const card = document.createElement("div");
    card.className = "ilmt-review-done";

    const title = document.createElement("p");
    title.className = "ilmt-review-done-title";
    title.textContent = "今天没有要复习的词";
    card.appendChild(title);

    const now = deps.now();
    const tomorrow = (state.all?.words ?? []).filter(
      (word) =>
        word.status === "learning" &&
        word.dueAt !== null &&
        word.dueAt > now &&
        word.dueAt <= now + 24 * 60 * 60 * 1000,
    ).length;
    const summary = document.createElement("p");
    summary.className = "ilmt-review-done-summary";
    summary.textContent = `本轮 ${state.answered} 个 · 答对 ${state.correct} · 明日还有 ${tomorrow} 个`;
    card.appendChild(summary);

    const today = document.createElement("p");
    today.className = "ilmt-review-done-today";
    today.textContent = `今天已复习 ${state.all?.stats.todayReviewed ?? 0} 个`;
    card.appendChild(today);

    container.appendChild(card);
  }

  function render(): void {
    if (destroyed) return;
    container.replaceChildren(...renderFilters());
    if (!current()) {
      renderFinish();
      return;
    }
    renderCard();
  }

  function currentTheme(): "light" | "dark" {
    try {
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  async function load(): Promise<void> {
    // A storage write from our own answer must not rebuild the queue while the
    // card is still advancing; replay it once the grade settles.
    if (state.busy) {
      pendingReload = true;
      return;
    }
    let next: LearningState;
    try {
      next = await deps.getState();
    } catch {
      next = { version: 1, words: [], stats: { day: "", todayReviewed: 0 }, updatedAt: 0 };
    }
    if (destroyed) return;

    state.all = next;
    const fresh = buildReviewQueue(next, { termLang: state.termLang, now: deps.now() });
    // Words answered earlier in this round are no longer due, so the fresh
    // queue is exactly the remaining work; keep the round's score separate.
    state.queue = fresh;
    state.total = state.answered + fresh.length;
    if (fresh.length > 0) state.revealed = false;
    render();
  }

  function refresh(): Promise<void> {
    chain = chain.then(load);
    return chain;
  }

  async function submit(grade: LearningGrade): Promise<void> {
    const word = current();
    if (!word || state.busy || destroyed) return;
    state.busy = true;
    render();

    let response: ReviewAnswerResponse;
    try {
      response = await deps.answer({
        type: "review-answer",
        id: word.id,
        grade,
        glossLang: state.glossLang || word.glossLang,
      });
    } catch {
      response = { ok: false } as unknown as ReviewAnswerResponse;
    }
    if (destroyed) return;
    state.busy = false;

    if (!response || response.ok !== true) {
      render();
      if (pendingReload) {
        pendingReload = false;
        void refresh();
      }
      return;
    }

    state.answered += 1;
    if (grade === "good") state.correct += 1;
    state.queue.shift();
    state.revealed = false;
    render();

    if (pendingReload) {
      pendingReload = false;
      void refresh();
    }
  }

  void refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      container.remove();
    },
  };
}
