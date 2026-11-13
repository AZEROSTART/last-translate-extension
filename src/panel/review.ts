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
import { buildSpotQuestion, shouldSpotCheck, type SpotQuestion } from "../shared/spot";
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

export interface ReviewOptions extends Partial<ReviewDeps> {
  /** Settings-level answer language; an in-session choice still wins. */
  defaultGlossLang?: () => string;
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
  /** Grade picked on the current card; written to storage only on 下一张. */
  pending: LearningGrade | null;
  /** True after "结束": a late storage reload must not resurrect the queue. */
  ended: boolean;
  /** Chosen option after a wrong spot check; the card waits for "下一张". */
  spotResult: { chosen: number; correct: boolean } | null;
}

export function mountReview(target: HTMLElement, over: ReviewOptions = {}): ReviewView {
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
    glossLang: readSession(GLOSS_LANG_KEY) || (over.defaultGlossLang?.() ?? ""),
    busy: false,
    pending: null,
    ended: false,
    spotResult: null,
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

  /** Stable per-word seed so the option order does not jump between renders. */
  function spotSeed(word: LearningWord): number {
    let hash = 2166136261;
    for (const char of `${word.id}:${word.reviewsCount}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
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
          state.ended = false;
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

  /** The answer opens on demand (看答案) or as soon as a grade is picked. */
  function answerShown(): boolean {
    return state.revealed || state.pending !== null;
  }

  function renderAnswer(word: LearningWord, card: HTMLElement, label = "想不起来，看答案"): void {
    if (!answerShown()) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "ilmt-review-reveal";
      reveal.textContent = label;
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
    answer.setAttribute("aria-live", "polite");

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
    end.addEventListener("click", () => void endRound());
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

    // The seed is stable per word, so rebuilding an answered spot card yields
    // the same options instead of reshuffling them.
    const question = shouldSpotCheck(word)
      ? buildSpotQuestion(
          word,
          state.all?.words ?? [],
          state.glossLang || word.glossLang,
          spotSeed(word),
        )
      : null;

    if (question) {
      renderSpot(word, card, question);
    } else {
      renderAnswer(word, card);
      renderGrades(card);
      if (state.pending !== null) renderNext(card);
    }

    container.appendChild(card);
  }

  function renderGrades(card: HTMLElement): void {
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
      const active = state.pending === grade;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", () => pickGrade(grade));
      grades.appendChild(button);
    }
    card.appendChild(grades);
  }

  function renderNext(card: HTMLElement): void {
    const next = document.createElement("button");
    next.type = "button";
    next.className = "ilmt-review-next";
    next.textContent = "下一张";
    next.disabled = state.busy;
    next.addEventListener("click", () => void commit());
    card.appendChild(next);
  }

  function renderSpot(word: LearningWord, card: HTMLElement, question: SpotQuestion): void {
    const result = state.spotResult;
    const options = document.createElement("div");
    options.className = "ilmt-review-options";
    question.options.forEach((meaning, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ilmt-review-option";
      button.dataset.index = String(index);
      button.textContent = meaning;
      button.disabled = state.busy || result !== null;
      if (result) {
        if (index === question.answer) button.classList.add("is-correct");
        if (index === result.chosen && !result.correct) button.classList.add("is-wrong");
      }
      button.addEventListener("click", () => pickSpotOption(index, question));
      options.appendChild(button);
    });
    card.appendChild(options);

    if (result && !result.correct) {
      const note = document.createElement("p");
      note.className = "ilmt-review-spot-note";
      note.textContent = `正确答案：${question.options[question.answer]}`;
      card.appendChild(note);
    }

    // One tap away before the check; always open once the card is graded.
    renderAnswer(word, card, "查看完整例句与全部释义");

    if (result) renderNext(card);
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

    // The user ended the round explicitly: offer a way back in without
    // reopening the panel, since the queue is no longer rebuilt from storage.
    if (state.ended) {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "ilmt-review-continue";
      again.textContent = "继续复习";
      again.addEventListener("click", () => {
        state.ended = false;
        state.answered = 0;
        state.correct = 0;
        void refresh();
      });
      card.appendChild(again);
    }

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
    // "结束" wins over any late reload until the user resumes the round.
    if (state.ended) return;
    // A graded card owns the view; replay this reload after the next card.
    if (state.pending !== null) {
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
    const previousId = state.queue[0]?.id;
    const fresh = buildReviewQueue(next, { termLang: state.termLang, now: deps.now() });
    // Words answered earlier in this round are no longer due, so the fresh
    // queue is exactly the remaining work; keep the round's score separate.
    state.queue = fresh;
    if (fresh[0]?.id !== previousId) state.spotResult = null;
    state.total = state.answered + fresh.length;
    if (fresh.length > 0) state.revealed = false;
    render();
  }

  function refresh(): Promise<void> {
    chain = chain.then(load);
    return chain;
  }

  function pickGrade(grade: LearningGrade): void {
    if (!current() || state.busy || destroyed) return;
    state.pending = grade;
    render();
  }

  /**
   * Write the card's final grade once. The grade stays provisional until the
   * user has seen the answer, so a re-grade never double-applies the schedule.
   */
  async function commit(): Promise<void> {
    const word = current();
    const grade = state.pending;
    if (!word || grade === null || state.busy || destroyed) return;
    state.busy = true;
    render();

    let response: ReviewAnswerResponse;
    try {
      response = await deps.answer({
        type: "review-answer",
        id: word.id,
        grade,
        glossLang: state.glossLang || word.glossLang,
        ...(state.spotResult
          ? { spot: true, spotCorrect: state.spotResult.correct }
          : {}),
      });
    } catch {
      response = { ok: false } as unknown as ReviewAnswerResponse;
    }
    if (destroyed) return;
    state.busy = false;

    if (!response || response.ok !== true) {
      // Stay on this card with the selection intact; 下一张 retries.
      render();
      flushPending();
      return;
    }

    state.answered += 1;
    if (grade === "good") state.correct += 1;
    state.queue.shift();
    state.revealed = false;
    state.pending = null;
    state.spotResult = null;
    render();
    flushPending();
  }

  /**
   * End the round. A visible grade still counts, so commit it first; the latch
   * keeps the write's own storage reload from putting the next card back.
   */
  async function endRound(): Promise<void> {
    state.ended = true;
    if (state.pending !== null) await commit();
    state.queue = [];
    state.revealed = false;
    state.pending = null;
    state.spotResult = null;
    state.busy = false;
    render();
  }

  /** Pick a spot option: the grade is derived from correctness and locked. */
  function pickSpotOption(choice: number, question: SpotQuestion): void {
    if (!current() || state.busy || state.spotResult || destroyed) return;
    const correct = choice === question.answer;
    state.spotResult = { chosen: choice, correct };
    state.pending = correct ? "good" : "again";
    render();
  }

  function flushPending(): void {
    if (!pendingReload) return;
    pendingReload = false;
    void refresh();
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
