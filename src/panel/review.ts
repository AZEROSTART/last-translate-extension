/**
 * Side-panel review view: one due word at a time, self-assessment, and an
 * optional answer language. Scheduling lives in `shared/srs.ts`; this module
 * only renders a queue and forwards grades to the background.
 *
 * The chat view and this view never share state; `main.ts` mounts this into
 * its own container and keeps the conversation alive while review is open.
 */

import { getLearning } from "../shared/learning-storage";
import { dueCount, formatDueLabel, isDue, previewDueLabel } from "../shared/srs";
import { buildSpotQuestion, shouldSpotCheck, type SpotQuestion } from "../shared/spot";
import type {
  LearningGrade,
  LearningState,
  LearningWord,
  MnemonicResponse,
  ReviewAnswerMessage,
  ReviewAnswerResponse,
  ReviewUndoFailure,
  ReviewUndoMessage,
  ReviewUndoResponse,
} from "../shared/types";
import { getEffect, getEffects } from "../content/effects";
import type { ClaimEffect, ClaimHandle } from "../content/effects/types";
import "../content/effects/gopher-hole";
import "../content/effects/magnet";
import "../content/effects/cat-hoard";
import "../content/effects/cat-sticker";

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
  /** Undo the last committed review; the background restores the snapshot. */
  undo(message: ReviewUndoMessage): Promise<ReviewUndoResponse>;
  /** One line of memorisation imagery for a word; cached by the background. */
  mnemonic(id: string): Promise<MnemonicResponse>;
  /** Never undefined when at least one effect is registered. */
  effect(id?: string): ClaimEffect;
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

async function defaultUndo(message: ReviewUndoMessage): Promise<ReviewUndoResponse> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return (response ?? { ok: false }) as ReviewUndoResponse;
  } catch {
    return { ok: false };
  }
}

function defaultEffect(id?: string): ClaimEffect {
  const all = getEffects();
  return (id ? getEffect(id) : undefined) ?? all[0];
}

let effectStyles: HTMLStyleElement | null = null;

/**
 * Effects own their CSS (scoped to `[data-ilmt-effect]`); the panel document
 * does not load the content stylesheet, so inject it once like the hover card.
 */
function ensureEffectStyles(): void {
  if (effectStyles?.isConnected) return;
  const css = getEffects()
    .map((effect) => effect.css ?? "")
    .join("\n");
  if (!css.trim()) return;
  effectStyles = document.createElement("style");
  effectStyles.dataset.ilmtEffects = "";
  effectStyles.textContent = css;
  (document.head ?? document.documentElement).appendChild(effectStyles);
}

export interface ReviewView {
  refresh(): Promise<void>;
  destroy(): void;
}

interface SceneState {
  status: "loading" | "ready" | "failed";
  caption?: string;
}

/** The one receipt kept after a successful commit; depth is fixed at one. */
interface Receipt {
  id: string;
  grade: LearningGrade;
  text: string;
  undoable: boolean;
}

const TERMINAL_UNDO_REASONS: ReviewUndoFailure[] = [
  "too-old",
  "unsupported",
  "not-latest",
  "unknown-word",
];

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
  /** Chosen option on the current spot card; the derived grade is locked. */
  spotResult: { chosen: number; correct: boolean } | null;
  /** The exact question that was answered, frozen so a re-render cannot reshuffle it. */
  spotQuestion: SpotQuestion | null;
  /** Last committed card; replaced by the next commit and dropped on undo. */
  receipt: Receipt | null;
}

/** Ask the background for the scene caption; any failure is a quiet one. */
async function defaultMnemonic(id: string): Promise<MnemonicResponse> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "mnemonic", id });
    if (response && typeof response === "object") return response as MnemonicResponse;
  } catch {
    // The panel stays usable without a background; the scene is optional.
  }
  return { ok: false, reason: "failed" };
}

export function mountReview(target: HTMLElement, over: ReviewOptions = {}): ReviewView {
  const deps: ReviewDeps = {
    getState: over.getState ?? (() => getLearning()),
    answer: over.answer ?? defaultAnswer,
    undo: over.undo ?? defaultUndo,
    mnemonic: over.mnemonic ?? defaultMnemonic,
    effect: over.effect ?? defaultEffect,
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
    spotQuestion: null,
    receipt: null,
  };

  let destroyed = false;
  let chain: Promise<void> = Promise.resolve();
  let pendingReload = false;
  /** The current card's decorative effect; rebuilt on every render. */
  let mountedEffect: ClaimHandle | null = null;
  /** The scene's own effect instance; rebuilt with the card. */
  let sceneEffect: ClaimHandle | null = null;
  /** Remembered per word so switching cards or grading never re-requests. */
  const scenes = new Map<string, SceneState>();
  const sceneRequests = new Set<string>();
  /** Undone words this round: never re-ask the question we just rolled back. */
  const suppressedSpot = new Set<string>();
  /** The word whose scene already performed, so re-renders do not replay it. */
  let playedFor: string | null = null;

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

  /** Fetch the caption once per word; success/failure both re-render. */
  function ensureScene(word: LearningWord): void {
    // A failed scene waits for an explicit retry; retrying on every render
    // would hammer the provider in a loop.
    if (scenes.has(word.id)) return;
    if (sceneRequests.has(word.id)) return;
    if (word.mnemonic) {
      scenes.set(word.id, { status: "ready", caption: word.mnemonic.caption });
      return;
    }
    sceneRequests.add(word.id);
    scenes.set(word.id, { status: "loading" });
    void deps
      .mnemonic(word.id)
      .then((response) => {
        scenes.set(
          word.id,
          response.ok
            ? { status: "ready", caption: response.mnemonic.caption }
            : { status: "failed" },
        );
      })
      .catch(() => {
        scenes.set(word.id, { status: "failed" });
      })
      .finally(() => {
        sceneRequests.delete(word.id);
        if (!destroyed) render();
      });
  }

  /**
   * The memorisation scene: the word's own claim effect performs while the
   * caption (one line of imagery) sits next to it. Not a second definition —
   * the picture is the point.
   */
  function renderScene(word: LearningWord, parent: HTMLElement): void {
    ensureScene(word);
    const scene = scenes.get(word.id) ?? { status: "loading" as const };

    const box = document.createElement("div");
    box.className = "ilmt-review-scene";
    box.dataset.scene = scene.status;

    const stage = document.createElement("div");
    stage.className = "ilmt-review-scene-stage";
    box.appendChild(stage);

    try {
      const effect = deps.effect(word.mascotId);
      ensureEffectStyles();
      const reduced = document.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      sceneEffect = effect.mount({
        doc: document,
        surface: stage,
        root: stage,
        theme: currentTheme(),
        animations: !reduced,
        claim: async () => ({ ok: true, created: false }),
        announce: () => {},
        label: (verb) => `${verb}`,
      });
      for (const button of stage.querySelectorAll("button")) button.tabIndex = -1;
    } catch {
      // A broken effect must never block reviewing.
      sceneEffect = null;
    }

    const text = document.createElement("div");
    text.className = "ilmt-review-scene-text";

    if (scene.status === "loading") {
      const pending = document.createElement("p");
      pending.className = "ilmt-review-scene-caption is-pending";
      pending.textContent = "给它想一个画面…";
      text.appendChild(pending);
    } else if (scene.status === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ilmt-review-scene-retry";
      retry.textContent = "画面没生成出来 · 重试";
      retry.addEventListener("click", () => {
        scenes.delete(word.id);
        render();
      });
      text.appendChild(retry);
    } else {
      const caption = document.createElement("p");
      caption.className = "ilmt-review-scene-caption";
      caption.textContent = scene.caption ?? "";
      const replay = document.createElement("button");
      replay.type = "button";
      replay.className = "ilmt-review-scene-replay";
      replay.textContent = "再看一次";
      replay.addEventListener("click", () => sceneEffect?.play?.());
      text.append(caption, replay);
      if (playedFor !== word.id) {
        playedFor = word.id;
        sceneEffect?.play?.();
      }
    }

    box.appendChild(text);
    parent.appendChild(box);
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

    renderScene(word, answer);

    const { full } = blankedSentence(word);
    const fullSentence = document.createElement("p");
    fullSentence.className = "ilmt-review-sentence-full";
    fullSentence.textContent = full;
    answer.appendChild(fullSentence);

    card.appendChild(answer);
  }

  function renderCard(): void {
    mountedEffect?.destroy();
    mountedEffect = null;
    sceneEffect?.destroy();
    sceneEffect = null;
    const card = document.createElement("div");
    card.className = "ilmt-review-card";
    card.tabIndex = -1;
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

    const effect = deps.effect(word.mascotId);
    const mascot = document.createElement("div");
    mascot.className = "ilmt-review-mascot";
    const host = document.createElement("div");
    host.className = "ilmt-review-effect-host";
    mascot.appendChild(host);
    card.appendChild(mascot);
    let handle: ClaimHandle | null = null;
    try {
      ensureEffectStyles();
      handle = effect.mount({
        doc: document,
        surface: mascot,
        root: host,
        theme: currentTheme(),
        animations: false,
        claim: async () => ({ ok: true, created: false }),
        announce: () => {},
        label: (verb) => `把${effect.label}${verb}下去`,
      });
      mascot.setAttribute("aria-hidden", "true");
      mascot.hidden = answerShown();
      for (const button of mascot.querySelectorAll("button")) button.tabIndex = -1;
    } catch {
      // A broken effect is decoration only; never block a review.
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
    // the same options instead of reshuffling them. Once answered, the exact
    // question is frozen: changing the answer language must not re-derive it.
    const question =
      state.spotQuestion ??
      (shouldSpotCheck(word) && !suppressedSpot.has(word.id)
        ? buildSpotQuestion(
            word,
            state.all?.words ?? [],
            state.glossLang || word.glossLang,
            spotSeed(word),
          )
        : null);

    if (question) {
      renderSpot(word, card, question);
    } else {
      renderAnswer(word, card);
      // A card that was answered as a spot check stays locked even if the
      // question can no longer be rebuilt.
      if (state.spotResult === null) renderGrades(card);
      if (state.pending !== null) renderNext(card);
    }

    container.appendChild(card);
    mountedEffect = handle;
  }

  function renderGrades(card: HTMLElement): void {
    const word = current();
    if (!word) return;
    const now = deps.now();
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
      button.disabled = state.busy;
      const name = document.createElement("span");
      name.className = "ilmt-review-grade-word";
      name.textContent = label;
      // The consequence is visible before the choice, not after it.
      const due = document.createElement("span");
      due.className = "ilmt-review-grade-due";
      due.textContent = previewDueLabel(word, grade, now);
      button.append(name, due);
      const active = state.pending === grade;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", () => pickGrade(grade));
      grades.appendChild(button);
    }
    card.appendChild(grades);

    const note = document.createElement("p");
    note.className = "ilmt-review-grade-note";
    note.textContent = "数字是下次见到它的时间";
    card.appendChild(note);
  }

  function renderNext(card: HTMLElement, note?: string): void {
    if (note) {
      const caption = document.createElement("p");
      caption.className = "ilmt-review-next-note";
      caption.textContent = note;
      card.appendChild(caption);
    }
    const next = document.createElement("button");
    next.type = "button";
    next.className = "ilmt-review-next";
    next.textContent = "下一张";
    next.disabled = state.busy;
    next.addEventListener("click", () => void commit());
    card.appendChild(next);
  }

  /** `记为认识 · 明天再见` for the card whose grade was derived, not picked. */
  function gradeConsequence(grade: LearningGrade): string {
    const word = current();
    if (!word) return "";
    const labels: Record<LearningGrade, string> = { again: "忘了", hard: "模糊", good: "认识" };
    const due = previewDueLabel(word, grade, deps.now());
    return `记为${labels[grade]} · ${due}${due === "已毕业" ? "" : "再见"}`;
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

    if (result) renderNext(card, state.pending ? gradeConsequence(state.pending) : undefined);
  }

  function renderFinish(): void {
    const card = document.createElement("div");
    card.className = "ilmt-review-done";

    const now = deps.now();
    const words = state.all?.words ?? [];
    const todayReviewed = state.all?.stats.todayReviewed ?? 0;

    // A: nothing has ever been claimed. The three zeros were never the point.
    if (words.length === 0) {
      const title = document.createElement("p");
      title.className = "ilmt-review-done-title";
      title.textContent = "还没有收录的词";
      const guide = document.createElement("p");
      guide.className = "ilmt-review-done-summary";
      guide.textContent = "翻译一页英文，把鼠标移到浅灰标记的词上，点卡片里的角色就能收进来。";
      const first = document.createElement("p");
      first.className = "ilmt-review-done-today";
      first.textContent = "翻译当前页：⌥A";
      card.append(title, guide, first);
      container.appendChild(card);
      return;
    }

    const remaining = words.filter((word) => isDue(word, now)).length;

    // B: the user stopped early and work is genuinely left.
    if (state.ended && remaining > 0) {
      const title = document.createElement("p");
      title.className = "ilmt-review-done-title";
      title.textContent = "本轮先到这";
      const summary = document.createElement("p");
      summary.className = "ilmt-review-done-summary";
      summary.textContent = `还有 ${remaining} 个到期`;
      const today = document.createElement("p");
      today.className = "ilmt-review-done-today";
      today.textContent = `今天已复习 ${todayReviewed} 个`;
      card.append(title, summary, today);

      const again = document.createElement("button");
      again.type = "button";
      again.className = "ilmt-review-continue";
      again.textContent = "继续复习";
      again.addEventListener("click", () => {
        state.ended = false;
        state.answered = 0;
        state.correct = 0;
        state.receipt = null;
        suppressedSpot.clear();
        void refresh();
      });
      card.appendChild(again);
      container.appendChild(card);
      return;
    }

    // C: today really is done.
    const title = document.createElement("p");
    title.className = "ilmt-review-done-title";
    title.textContent = "今天没有要复习的词";
    card.appendChild(title);

    const tomorrow = words.filter(
      (word) => word.status === "learning" && word.dueAt !== null && word.dueAt > now &&
        word.dueAt <= now + 24 * 60 * 60 * 1000,
    ).length;
    const parts: string[] = [];
    if (state.answered > 0) parts.push(`本轮 ${state.answered} 个 · 认识 ${state.correct}`);
    if (tomorrow > 0) parts.push(`明日还有 ${tomorrow} 个`);
    if (parts.length > 0) {
      const summary = document.createElement("p");
      summary.className = "ilmt-review-done-summary";
      summary.textContent = parts.join(" · ");
      card.appendChild(summary);
    }

    const today = document.createElement("p");
    today.className = "ilmt-review-done-today";
    today.textContent = `今天已复习 ${todayReviewed} 个`;
    card.appendChild(today);

    container.appendChild(card);
  }

  /** One line above the card: what was just written, and one way back. */
  function renderReceipt(): HTMLElement {
    const receipt = state.receipt!;
    const row = document.createElement("div");
    row.className = "ilmt-review-receipt";
    row.setAttribute("role", "status");
    row.setAttribute("aria-live", "polite");

    const text = document.createElement("span");
    text.textContent = receipt.text;
    row.appendChild(text);

    if (receipt.undoable) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "ilmt-review-receipt-undo";
      undo.textContent = "撤销";
      undo.disabled = state.busy;
      undo.addEventListener("click", () => void undoLast());
      row.appendChild(undo);
    }
    return row;
  }

  function render(): void {
    if (destroyed) return;
    // Also covers leaving the card for the finish view, where renderCard never runs.
    mountedEffect?.destroy();
    mountedEffect = null;
    container.replaceChildren(...renderFilters());
    if (state.receipt) container.appendChild(renderReceipt());
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
    if (fresh[0]?.id !== previousId) {
      state.spotResult = null;
      state.spotQuestion = null;
    }
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
    const dueAt = response.word?.dueAt ?? null;
    // Anchor to the write's own timestamp: the panel's clock is a few ms later
    // than the background's, which would turn "明天" into "24 小时后".
    const recordedAt = response.word?.updatedAt ?? deps.now();
    const due = formatDueLabel(dueAt, recordedAt);
    state.receipt = {
      id: word.id,
      grade,
      text: `已记录 · ${due}${dueAt === null ? "" : "再见"}`,
      undoable: true,
    };
    state.queue.shift();
    state.revealed = false;
    state.pending = null;
    state.spotResult = null;
    state.spotQuestion = null;
    render();
    flushPending();
  }

  /**
   * Undo the last committed card, once. The background restores the snapshot;
   * counts roll back here, and the queue is rebuilt from storage so the same
   * card returns in its idle state.
   */
  async function undoLast(): Promise<void> {
    const receipt = state.receipt;
    if (!receipt || !receipt.undoable || state.busy || destroyed) return;
    state.busy = true;
    render();

    let response: ReviewUndoResponse;
    try {
      response = await deps.undo({ type: "review-undo", id: receipt.id });
    } catch {
      response = { ok: false };
    }
    if (destroyed) return;
    state.busy = false;

    if (!response || response.ok !== true) {
      const reason = response && response.ok === false ? response.reason : undefined;
      const terminal = reason !== undefined && TERMINAL_UNDO_REASONS.includes(reason);
      state.receipt = terminal
        ? { ...receipt, text: "这张改不回来了", undoable: false }
        : { ...receipt, text: "撤销失败 · 再试一次", undoable: true };
      render();
      return;
    }

    state.receipt = null;
    state.answered = Math.max(0, state.answered - 1);
    if (receipt.grade === "good") state.correct = Math.max(0, state.correct - 1);
    suppressedSpot.add(receipt.id);
    // Undo brings the card back even after 结束, without resetting this round.
    state.ended = false;
    state.pending = null;
    state.revealed = false;
    state.spotResult = null;
    state.spotQuestion = null;
    render();
    await refresh();
    if (!destroyed) container.querySelector<HTMLElement>(".ilmt-review-card")?.focus();
  }

  /**
   * End the round. A visible grade still counts, so commit it first; the latch
   * keeps the write's own storage reload from putting the next card back.
   */
  async function endRound(): Promise<void> {
    state.ended = true;
    if (state.pending !== null) await commit();
    // One explicit local read so "还有 N 个到期" is not a stale snapshot; the
    // write above has landed, and nothing else refreshes the finish page.
    try {
      state.all = await deps.getState();
    } catch {
      // Keep the last snapshot; the finish page can only tell the truth it has.
    }
    if (destroyed) return;
    state.queue = [];
    state.revealed = false;
    state.pending = null;
    state.spotResult = null;
    state.spotQuestion = null;
    state.busy = false;
    render();
  }

  /** Pick a spot option: the grade is derived from correctness and locked. */
  function pickSpotOption(choice: number, question: SpotQuestion): void {
    if (!current() || state.busy || state.spotResult || destroyed) return;
    const correct = choice === question.answer;
    state.spotResult = { chosen: choice, correct };
    state.spotQuestion = question;
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
      mountedEffect?.destroy();
      mountedEffect = null;
      container.remove();
    },
  };
}
