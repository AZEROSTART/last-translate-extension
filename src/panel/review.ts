/**
 * Side-panel review view: one due word at a time, a blanked sentence, and one
 * question — did you remember it? Scheduling lives in `shared/srs.ts`; this
 * module only renders a queue and forwards the honest answer to the background.
 *
 * The chat view and this view never share state; `main.ts` mounts this into
 * its own container and keeps the conversation alive while review is open.
 */

import { daysSinceDay, getLearning, localDay, normalizeSurface } from "../shared/learning-storage";
import { dueCount, formatDueLabel, isDue } from "../shared/srs";
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
  WordContext,
} from "../shared/types";
import { getEffect, getEffects } from "../content/effects";
import type { ClaimEffect, ClaimHandle } from "../content/effects/types";
import "../content/effects/gopher-hole";
import "../content/effects/magnet";
import "../content/effects/cat-hoard";
import "../content/effects/cat-sticker";

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

export interface ReviewDeps {
  getState(): Promise<LearningState>;
  answer(message: ReviewAnswerMessage): Promise<ReviewAnswerResponse>;
  /** Undo the last committed review; the background restores the snapshot. */
  undo(message: ReviewUndoMessage): Promise<ReviewUndoResponse>;
  /** One line of memorisation imagery for a word; cached by the background. */
  mnemonic(id: string): Promise<MnemonicResponse>;
  /** Never undefined when at least one effect is registered. */
  effect(id?: string): ClaimEffect;
  /** Settings-level answer language; it wins over the word's own gloss. */
  defaultGlossLang(): string;
  now(): number;
}

export interface ReviewOptions extends Partial<ReviewDeps> {}

/** Due cards only, oldest due first. */
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

/** A card is a question, an answer, or the lesson after a miss. */
type ReviewPhase = "prompt" | "revealed" | "lesson";

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
  /** Cards answered with 没想起来 this round; the only number worth reporting. */
  missed: number;
  phase: ReviewPhase;
  busy: boolean;
  /** True after "结束": a late storage reload must not resurrect the queue. */
  ended: boolean;
  /** Last committed card; replaced by the next commit and dropped on undo. */
  receipt: Receipt | null;
  /** Words that finished the ladder this round; memory only, never stored. */
  graduated: LearningWord[];
  /** A failed write keeps the card in place and says so, without moving on. */
  error: string | null;
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

/** The preferred answer language, then the word's own, then the first gloss. */
function primaryMeaning(word: LearningWord, preferred: string): string {
  const primary =
    (preferred ? word.glosses.find((gloss) => gloss.lang === preferred) : undefined) ??
    word.glosses.find((gloss) => gloss.lang === word.glossLang) ??
    word.glosses[0];
  return primary?.meaning.trim() ?? "";
}

/** Keep a link only when it is a real web address; never run or open anything else. */
export function safeHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The page label that needs no path: just the host. */
export function urlHostname(safeUrl: string): string {
  try {
    return new URL(safeUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * Split one sentence around the surface, keeping the exact Unicode script
 * boundaries used by recall. `null` means this sentence cannot be masked.
 */
export function maskSentence(surface: string, sentence: string): string[] | null {
  const trimmedSurface = surface.trim();
  const trimmedSentence = sentence.trim();
  if (!trimmedSurface || !trimmedSentence) return null;
  const literal = trimmedSurface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Script boundaries, unlike JavaScript's ASCII-only \b, allow adjacent CJK
  // characters while keeping e.g. “été” out of the middle of a French word.
  const spaced = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}_]/u;
  const boundary = "[\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{N}\\p{M}_]";
  const left = spaced.test(trimmedSurface[0]) ? `(?<!${boundary})` : "";
  const right = spaced.test(trimmedSurface.at(-1)!) ? `(?!${boundary})` : "";
  const pattern = new RegExp(left + literal + right, "iu");
  const parts = trimmedSentence.split(pattern);
  if (parts.length > 1 && parts.some((part) => /[\p{L}\p{N}]/u.test(part))) return parts;
  return null;
}

/**
 * Contexts newest-first, without blank or repeated sentences. The first
 * maskable sentence moves to index 0 so the existing recall card is unchanged.
 */
export function orderedContexts(word: LearningWord): WordContext[] {
  const seen = new Set<string>();
  const ordered: WordContext[] = [];
  for (let index = word.contexts.length - 1; index >= 0; index--) {
    const context = word.contexts[index];
    const sentence = context.sentence.trim();
    if (!sentence || seen.has(sentence)) continue;
    seen.add(sentence);
    ordered.push(context);
  }
  const firstMaskable = ordered.findIndex(
    (context) => maskSentence(word.surface, context.sentence) !== null,
  );
  if (firstMaskable > 0) {
    const [context] = ordered.splice(firstMaskable, 1);
    ordered.unshift(context);
  }
  return ordered;
}

/** Prefer the latest context with a complete, maskable occurrence. */
function recallContext(word: LearningWord): { sentence: string; parts: string[] } | null {
  for (let index = word.contexts.length - 1; index >= 0; index--) {
    const sentence = word.contexts[index].sentence.trim();
    const parts = maskSentence(word.surface, sentence);
    if (parts) return { sentence, parts };
  }
  return null;
}

/** A recall card is one that has both a remembered attempt and a maskable sentence. */
function isRecallCard(word: LearningWord): boolean {
  return word.reviewsCount > 0 && recallContext(word) !== null;
}

/** Keyboard on a text field belongs to the field, not to the review. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'),
  );
}

/** A native button or link already answers Space/Enter itself. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a"));
}

export function mountReview(target: HTMLElement, over: ReviewOptions = {}): ReviewView {
  const deps: ReviewDeps = {
    getState: over.getState ?? (() => getLearning()),
    answer: over.answer ?? defaultAnswer,
    undo: over.undo ?? defaultUndo,
    mnemonic: over.mnemonic ?? defaultMnemonic,
    effect: over.effect ?? defaultEffect,
    defaultGlossLang: over.defaultGlossLang ?? (() => ""),
    now: over.now ?? (() => Date.now()),
  };

  const container = node("div", "ilmt-review");
  target.appendChild(container);

  const state: ReviewState = {
    all: null,
    queue: [],
    total: 0,
    answered: 0,
    missed: 0,
    phase: "prompt",
    busy: false,
    ended: false,
    receipt: null,
    graduated: [],
    error: null,
  };

  let destroyed = false;
  let pendingGrade: LearningGrade | null = null;
  let chain: Promise<void> = Promise.resolve();
  let pendingReload = false;
  /** The scene's own effect instance; rebuilt with the lesson. */
  let sceneEffect: ClaimHandle | null = null;
  /** Static effects on the finish page's graduation rows; rebuilt on render. */
  let graduatedEffects: ClaimHandle[] = [];
  /** Remembered per word so switching cards or grading never re-requests. */
  const scenes = new Map<string, SceneState>();
  const sceneRequests = new Set<string>();
  /** The word whose scene already performed, so re-renders do not replay it. */
  let playedFor: string | null = null;

  function current(): LearningWord | undefined {
    return state.queue[0];
  }

  let draft = "";
  /** Which source sentence the revealed answer is quoting; resets per card. */
  let activeContextIndex = 0;

  /** The library itself, not the debt; never clickable. */
  function renderShelf(): HTMLElement | null {
    const words = state.all?.words;
    if (!words || words.length === 0) return null;
    const mastered = words.filter((item) => item.status === "mastered").length;
    return node(
      "p",
      "ilmt-review-shelf",
      mastered > 0
        ? `已收录 ${words.length} 个 · 已毕业 ${mastered} 个`
        : `已收录 ${words.length} 个`,
    );
  }

  /**
   * Only when the absence is real (3+ days), the work is real (something is
   * due), and the date can be trusted. It states; it never asks for anything.
   */
  function renderReturn(): HTMLElement | null {
    const all = state.all;
    if (!all) return null;
    const now = deps.now();
    const gap = daysSinceDay(all.stats.day, now);
    if (gap === null || gap < 3) return null;
    if (dueCount(all.words, now) <= 0) return null;
    return node(
      "p",
      "ilmt-review-return",
      gap <= 13
        ? `有 ${gap} 天没见了 · ${all.words.length} 个词都还在`
        : `有一阵子没见了 · ${all.words.length} 个词都还在`,
    );
  }

  /** Fetch the caption once per word; success/failure both re-render. */
  function ensureScene(word: LearningWord): void {
    // A failed scene waits for an explicit retry; retrying on every render
    // would hammer the provider in a loop.
    if (scenes.has(word.id) || sceneRequests.has(word.id)) return;
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
        // Turning the page while the model is still thinking must not pull
        // the next card back to the lesson it just left. A late answer also
        // must not re-render a lesson the user already graded "good".
        if (
          !destroyed &&
          state.phase === "lesson" &&
          pendingGrade === "again" &&
          current()?.id === word.id
        ) {
          const focusedNext = container.querySelector(".ilmt-review-next:focus") !== null;
          render();
          if (focusedNext) container.querySelector<HTMLButtonElement>(".ilmt-review-next")?.focus();
        }
      });
  }

  /**
   * The memorisation scene: the word's claim effect performs while one line of
   * imagery sits next to it. It only ever appears after 没想起来.
   */
  function renderScene(word: LearningWord, parent: HTMLElement): void {
    ensureScene(word);
    const scene = scenes.get(word.id) ?? { status: "loading" as const };
    const box = node("div", "ilmt-review-scene");
    box.dataset.scene = scene.status;
    const stage = node("div", "ilmt-review-scene-stage");
    stage.setAttribute("aria-hidden", "true");
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

    const text = node("div", "ilmt-review-scene-text");
    if (scene.status === "loading") {
      text.appendChild(node("p", "ilmt-review-scene-caption is-pending", "给它想一个画面…"));
    } else if (scene.status === "failed") {
      const retry = node("button", "ilmt-review-scene-retry", "画面没生成出来 · 重试");
      retry.type = "button";
      retry.addEventListener("click", () => {
        scenes.delete(word.id);
        render();
      });
      text.appendChild(retry);
    } else {
      text.appendChild(node("p", "ilmt-review-scene-caption", scene.caption ?? ""));
      if (playedFor !== word.id) {
        playedFor = word.id;
        sceneEffect?.play?.();
      }
    }
    box.appendChild(text);
    parent.appendChild(box);
  }

  /** Source origin and the way to cycle the other sentences it was seen in. */
  function renderMeta(word: LearningWord, parent: HTMLElement): void {
    const contexts = orderedContexts(word);
    if (contexts.length === 0) return;
    const index = activeContextIndex % contexts.length;
    const context = contexts[index];
    const safeUrl = safeHttpUrl(context.pageUrl ?? "");
    const label = context.pageTitle?.trim() || (safeUrl ? urlHostname(safeUrl) : "");
    const meta = node("div", "ilmt-review-meta");

    if (safeUrl) {
      const source = node("div", "ilmt-review-source");
      const link = node("a", "ilmt-review-source-link", `来自：${label}`);
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = label;
      source.appendChild(link);
      meta.appendChild(source);
    } else if (label) {
      const source = node("div", "ilmt-review-source");
      const span = node("span", "ilmt-review-source-label", `来自：${label}`);
      span.title = label;
      source.appendChild(span);
      meta.appendChild(source);
    }

    if (contexts.length >= 2) {
      const switchButton = node(
        "button",
        "ilmt-review-context-switch",
        `换一句 (${index + 1}/${contexts.length})`,
      );
      switchButton.type = "button";
      switchButton.addEventListener("click", () => {
        if (destroyed || state.busy) return;
        const currentWord = current();
        if (!currentWord || currentWord.id !== word.id) return;
        const total = orderedContexts(currentWord).length;
        if (total === 0) return;
        activeContextIndex = (activeContextIndex + 1) % total;
        render();
        container.querySelector<HTMLButtonElement>(".ilmt-review-context-switch")?.focus();
      });
      meta.appendChild(switchButton);
    }

    if (meta.childElementCount > 0) parent.appendChild(meta);
  }

  /** The answer, with the blank still open: the word above is enough. */
  function renderMeaning(word: LearningWord, parent: HTMLElement): void {
    const answer = node("div", "ilmt-review-answer");
    answer.setAttribute("aria-live", "polite");
    const meaning = node("div", "ilmt-review-meaning");
    const text = primaryMeaning(word, deps.defaultGlossLang());
    if (text) {
      meaning.textContent = text;
    } else {
      meaning.textContent = "释义还没生成";
      meaning.classList.add("is-placeholder");
    }
    answer.appendChild(meaning);
    renderMeta(word, answer);
    parent.appendChild(answer);
  }

  /** Two equal buttons. Neither is the right answer; both are the truth. */
  function renderChoices(card: HTMLElement): void {
    const actions = node("div", "ilmt-review-actions");
    const choices = node("div", "ilmt-review-choices");
    const buttons: Array<[LearningGrade, string]> = [
      ["good", "想起来了"],
      ["again", "没想起来"],
    ];
    for (const [grade, label] of buttons) {
      const button = node("button", "ilmt-review-grade", label);
      button.type = "button";
      button.dataset.grade = grade;
      button.setAttribute(
        "aria-keyshortcuts",
        grade === "good" ? "1 ArrowRight" : "2 ArrowLeft",
      );
      button.disabled = state.busy;
      button.addEventListener("click", () => {
        if (container.contains(button)) pickGrade(grade);
      });
      choices.appendChild(button);
    }
    actions.appendChild(choices);
    if (state.error) actions.appendChild(node("p", "ilmt-review-error", state.error));
    card.appendChild(actions);
  }

  /** The only screen that teaches: definition, one picture, then 下一张. */
  function renderLesson(word: LearningWord, card: HTMLElement): void {
    const lesson = node("div", "ilmt-review-lesson");
    renderMeaning(word, lesson);
    if (pendingGrade === "again") renderScene(word, lesson);

    const actions = node("div", "ilmt-review-actions");
    const next = node("button", "ilmt-review-next", "下一张");
    next.type = "button";
    next.setAttribute("aria-keyshortcuts", "Space Enter");
    next.disabled = state.busy;
    next.addEventListener("click", () => {
      if (current()?.id === word.id) void advance();
    });
    // A quiet correction, below the one commit button: the grade is a guess,
    // and saying so after seeing the answer is the point of the lesson.
    const regrade = node(
      "button",
      "ilmt-review-regrade",
      pendingGrade === "good" ? "其实没想起来" : "其实想起来了",
    );
    regrade.type = "button";
    regrade.disabled = state.busy;
    regrade.addEventListener("click", () => {
      if (
        state.phase !== "lesson" ||
        state.busy ||
        destroyed ||
        current()?.id !== word.id
      ) {
        return;
      }
      pendingGrade = pendingGrade === "good" ? "again" : "good";
      state.error = null;
      render();
      container.querySelector<HTMLButtonElement>(".ilmt-review-next")?.focus();
    });
    if (state.error) actions.appendChild(node("p", "ilmt-review-error", state.error));
    actions.append(next, regrade);
    lesson.appendChild(actions);
    card.appendChild(lesson);
  }

  /** The typed spelling, shown next to the answer it was checked against. */
  function renderSpellingFeedback(word: LearningWord, parent: HTMLElement): void {
    if (!draft.trim()) return;
    const typed = normalizeSurface(draft.normalize("NFKC"));
    const match = typed === normalizeSurface(word.surface.normalize("NFKC"));
    const feedback = node(
      "p",
      "ilmt-review-feedback",
      match ? "拼写一致" : `你写的是「${draft.trim()}」`,
    );
    feedback.setAttribute("role", "status");
    parent.appendChild(feedback);
  }

  /** Reveal the missed spelling on the same card; shared by the form and the keyboard. */
  function revealRecall(expectedId?: string): void {
    const word = current();
    if (!word || state.phase !== "prompt" || state.busy || destroyed) return;
    if (expectedId !== undefined && word.id !== expectedId) return;
    if (!isRecallCard(word)) return;
    state.phase = "revealed";
    state.error = null;
    render();
    container.querySelector<HTMLButtonElement>(".ilmt-review-grade")?.focus();
  }

  function renderSpellingPrompt(word: LearningWord, card: HTMLElement): void {
    const actions = node("form", "ilmt-review-actions");
    const input = node("input", "ilmt-review-input");
    input.setAttribute("aria-label", "填写原词");
    input.placeholder = "填入原词，也可以默想";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.lang = word.termLang;
    input.value = draft;
    input.addEventListener("input", () => {
      draft = input.value;
    });
    actions.appendChild(input);
    const reveal = node("button", "ilmt-review-reveal", "看答案");
    reveal.type = "submit";
    actions.addEventListener("submit", (event) => {
      event.preventDefault();
      revealRecall(word.id);
    });
    actions.appendChild(reveal);
    card.appendChild(actions);
  }

  function renderCard(): void {
    const card = node("div", "ilmt-review-card");
    card.tabIndex = -1;
    const word = current();
    if (!word) return;

    const head = node("div", "ilmt-review-head");
    const position = state.answered + 1;
    const progress = node("span", "ilmt-review-progress", `${position} / ${state.total}`);
    const end = node("button", "ilmt-review-end", "结束");
    end.type = "button";
    end.addEventListener("click", () => void endRound());
    const contexts = orderedContexts(word);
    const contextIndex = state.phase === "prompt" || contexts.length === 0
      ? 0
      : activeContextIndex % contexts.length;
    const activeContext = contexts[contextIndex];
    const maskedParts = activeContext ? maskSentence(word.surface, activeContext.sentence) : null;
    const sentenceText = activeContext?.sentence.trim() ?? "";
    const meaning = primaryMeaning(word, deps.defaultGlossLang());
    const recall = isRecallCard(word);
    const asking = recall && state.phase === "prompt";
    const cue = meaning && !normalizeSurface(meaning).includes(normalizeSurface(word.surface))
      ? meaning
      : "回想空缺的原词";
    const mode = node("span", "ilmt-review-mode", recall ? "原句找词" : "回想词义");
    const meter = node("progress", "ilmt-review-meter");
    meter.setAttribute("aria-label", "本轮已复习");
    meter.max = state.total;
    meter.value = state.answered;
    head.append(mode, progress, end);
    card.append(head, meter);

    const term = node("div", "ilmt-review-term");
    term.appendChild(asking
      ? node("span", "ilmt-review-cue", cue)
      : node("span", "ilmt-review-word", word.surface));
    if (word.pos) term.appendChild(node("span", "ilmt-review-pos", word.pos));
    // A language label only earns its space when the queue mixes targets.
    const langs = new Set((state.all?.words ?? []).map((item) => item.termLang));
    if (langs.size >= 2) {
      term.appendChild(node("span", "ilmt-review-lang-label", langLabel(word.termLang)));
    }
    card.appendChild(term);

    const parts = maskedParts ?? [sentenceText];
    if (maskedParts || sentenceText) {
      const sentence = node("p", "ilmt-review-sentence");
      (recall && !asking ? [sentenceText] : parts).forEach((part, index) => {
        if (index > 0) {
          const blank = node("span", "ilmt-review-blank", "____");
          blank.setAttribute("role", "img");
          blank.setAttribute("aria-label", "空");
          sentence.appendChild(blank);
        }
        if (part) sentence.appendChild(document.createTextNode(part));
      });
      card.appendChild(sentence);
    }

    if (state.phase === "prompt" && !asking) {
      renderChoices(card);
    } else if (asking) {
      renderSpellingPrompt(word, card);
    } else if (state.phase === "revealed") {
      if (recall && draft.trim()) renderSpellingFeedback(word, card);
      renderMeaning(word, card);
      renderChoices(card);
    } else {
      if (recall && draft.trim()) renderSpellingFeedback(word, card);
      renderLesson(word, card);
    }
    card.appendChild(
      node("p", "ilmt-review-keys", "1 想起来 · 2 没想起来 · Space 下一张 · Z 撤销"),
    );
    container.appendChild(card);
  }

  function destroyGraduated(): void {
    for (const handle of graduatedEffects) handle.destroy();
    graduatedEffects = [];
  }

  /**
   * One quiet closing line per word that finished the ladder: the mascot that
   * kept it, held still, and its name. Three rows at most; the rest is a count.
   */
  function renderGraduated(): HTMLElement | null {
    if (state.graduated.length === 0) return null;
    const block = node("div", "ilmt-review-graduated");
    for (const word of state.graduated.slice(0, 3)) {
      const row = node("div", "ilmt-review-graduated-row");
      const stage = node("div", "ilmt-review-scene-stage");
      stage.setAttribute("aria-hidden", "true");
      row.appendChild(stage);
      try {
        const effect = deps.effect(word.mascotId);
        ensureEffectStyles();
        const handle = effect.mount({
          doc: document,
          surface: stage,
          root: stage,
          theme: currentTheme(),
          animations: false,
          claim: async () => ({ ok: true, created: false }),
          announce: () => {},
          label: (verb) => `${verb}`,
        });
        graduatedEffects.push(handle);
        // The word is already kept: hold the effect in its quiet kept pose.
        handle.setState("known");
        for (const button of stage.querySelectorAll("button")) button.tabIndex = -1;
      } catch {
        // Decoration only: the word's line still carries the news.
        stage.remove();
      }
      row.appendChild(node("span", "ilmt-review-graduated-word", `${word.surface} 毕业了`));
      block.appendChild(row);
    }
    const rest = state.graduated.length - 3;
    if (rest > 0) {
      block.appendChild(node("p", "ilmt-review-graduated-more", `还有 ${rest} 个也毕业了`));
    }
    return block;
  }

  function renderFinish(): void {
    const card = node("div", "ilmt-review-done");
    const now = deps.now();
    const words = state.all?.words ?? [];
    const todayReviewed =
      state.all && state.all.stats.day === localDay(now) ? state.all.stats.todayReviewed : 0;

    // A: nothing has ever been claimed. The three zeros were never the point.
    if (words.length === 0) {
      card.append(
        node("p", "ilmt-review-done-title", "还没有收录的词"),
        node(
          "p",
          "ilmt-review-done-summary",
          "翻译一页英文，把鼠标移到浅灰标记的词上，点卡片里的角色就能收进来。",
        ),
        node("p", "ilmt-review-done-today", "翻译当前页：⌥A"),
      );
      container.appendChild(card);
      return;
    }

    const remaining = words.filter((word) => isDue(word, now)).length;
    const graduated = renderGraduated();

    // B: the user stopped early and work is genuinely left.
    if (state.ended && remaining > 0) {
      card.append(
        node("p", "ilmt-review-done-title", "本轮先到这"),
        node("p", "ilmt-review-done-summary", `还有 ${remaining} 个到期`),
      );
      if (graduated) card.appendChild(graduated);
      card.appendChild(node("p", "ilmt-review-done-today", `今天已复习 ${todayReviewed} 个`));

      const again = node("button", "ilmt-review-continue", "继续复习");
      again.type = "button";
      again.addEventListener("click", () => {
        state.ended = false;
        state.answered = 0;
        state.missed = 0;
        state.graduated = [];
        state.receipt = null;
        state.phase = "prompt";
        state.error = null;
        activeContextIndex = 0;
        void refresh();
      });
      card.appendChild(again);
      container.appendChild(card);
      return;
    }

    // C: the round is over (or there was nothing due when it opened).
    card.appendChild(
      node(
        "p",
        "ilmt-review-done-title",
        state.answered > 0 ? `${state.answered} 个都过完了` : "今天没有要复习的词",
      ),
    );

    const parts: string[] = [];
    if (state.answered > 0) {
      // Only the misses are worth a number: "remembered" can only grow by
      // being generous with the truth.
      if (state.missed > 0) parts.push(`${state.missed} 个没想起来`);
    } else {
      const tomorrow = words.filter(
        (word) =>
          word.status === "learning" &&
          word.dueAt !== null &&
          word.dueAt > now &&
          word.dueAt <= now + 24 * 60 * 60 * 1000,
      ).length;
      if (tomorrow > 0) parts.push(`明日还有 ${tomorrow} 个`);
    }
    if (parts.length > 0) {
      card.appendChild(node("p", "ilmt-review-done-summary", parts.join(" · ")));
    }
    if (graduated) card.appendChild(graduated);
    card.appendChild(node("p", "ilmt-review-done-today", `今天已复习 ${todayReviewed} 个`));
    container.appendChild(card);
  }

  /** One line above the card: the word just passed, and one way back. */
  function renderReceipt(): HTMLElement {
    const receipt = state.receipt!;
    const row = node("div", "ilmt-review-receipt");
    row.setAttribute("role", "status");
    row.setAttribute("aria-live", "polite");
    row.appendChild(node("span", "", receipt.text));
    if (receipt.undoable) {
      const undo = node("button", "ilmt-review-receipt-undo", "撤销");
      undo.type = "button";
      undo.setAttribute("aria-keyshortcuts", "z Control+z Meta+z");
      undo.disabled = state.busy;
      undo.addEventListener("click", () => void undoLast());
      row.appendChild(undo);
    }
    return row;
  }

  function render(): void {
    if (destroyed) return;
    sceneEffect?.destroy();
    sceneEffect = null;
    destroyGraduated();
    container.replaceChildren();
    const shelf = renderShelf();
    if (shelf) container.appendChild(shelf);
    const comeback = renderReturn();
    if (comeback) container.appendChild(comeback);
    // The lesson already carries its meaning; the receipt waits for the turn.
    if (state.receipt && state.phase !== "lesson") container.appendChild(renderReceipt());
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
    // card is still advancing; replay it once the answer settles.
    if (state.busy) {
      pendingReload = true;
      return;
    }
    // "结束" wins over any late reload until the user resumes the round.
    if (state.ended) return;
    // A revealed or missed card owns the view; replay this reload after it.
    if (state.phase !== "prompt") {
      pendingReload = true;
      return;
    }
    let next: LearningState;
    try {
      next = await deps.getState();
    } catch {
      next = { version: 1, words: [], stats: { day: "", todayReviewed: 0 }, updatedAt: 0 };
    }
    if (destroyed || state.ended) return;
    // Reading storage is asynchronous. A card can open or start accepting IME
    // input during the read. Preserve that interaction until the turn ends.
    if (state.busy || state.phase !== "prompt" || container.querySelector(".ilmt-review-input:focus")) {
      pendingReload = true;
      return;
    }

    const previousId = current()?.id;
    state.all = next;
    // Words answered earlier in this round are no longer due, so the fresh
    // queue is exactly the remaining work; keep the round's score separate.
    state.queue = buildReviewQueue(next, { termLang: ALL, now: deps.now() });
    state.total = state.answered + state.queue.length;
    if (current()?.id !== previousId) {
      draft = "";
      activeContextIndex = 0;
    }
    render();
  }

  function refresh(): Promise<void> {
    chain = chain.then(load);
    return chain;
  }

  function pickGrade(grade: LearningGrade): void {
    if (state.phase === "lesson" || state.ended || state.busy || destroyed) return;
    pendingGrade = grade;
    state.phase = "lesson";
    state.error = null;
    render();
    container.querySelector<HTMLButtonElement>(".ilmt-review-next")?.focus();
  }

  async function advance(): Promise<void> {
    const word = current();
    const grade = pendingGrade;
    if (!word || !grade || state.phase !== "lesson" || state.busy || destroyed) return;
    state.busy = true;
    state.error = null;
    render();

    let response: ReviewAnswerResponse;
    try {
      response = await deps.answer({
        type: "review-answer",
        id: word.id,
        grade,
        glossLang: word.glossLang,
      });
    } catch {
      response = { ok: false } as unknown as ReviewAnswerResponse;
    }
    if (destroyed) return;
    state.busy = false;

    if (!response || response.ok !== true) {
      // Keep the selected grade so 下一张 can retry the same write.
      state.error = "没写进去 · 再点一次";
      render();
      return;
    }

    // Replace in place so the shelf shows a graduation on this very frame,
    // without waiting for the storage change listener.
    const updated = response.word ?? word;
    if (state.all) {
      const day = localDay(deps.now());
      const stats =
        response.stats ??
        (state.all.stats.day === day
          ? { day, todayReviewed: state.all.stats.todayReviewed + 1 }
          : { day, todayReviewed: 1 });
      state.all = {
        ...state.all,
        words: state.all.words.map((item) => (item.id === updated.id ? updated : item)),
        stats,
      };
    }
    if (updated.status === "mastered" && !state.graduated.some((item) => item.id === updated.id)) {
      state.graduated.push(updated);
    }

    draft = "";
    state.answered += 1;
    if (grade === "again") state.missed += 1;

    const dueAt = updated.dueAt ?? null;
    // Anchor to the write's own timestamp: the panel's clock is a few ms later
    // than the background's, which would turn "明天" into "24 小时后".
    const due = formatDueLabel(dueAt, updated.updatedAt ?? deps.now());
    state.receipt = {
      id: word.id,
      grade,
      text: [
        updated.surface,
        primaryMeaning(updated, deps.defaultGlossLang()),
        dueAt === null ? due : `${due}再见`,
      ]
        .filter((part) => part.length > 0)
        .join(" · "),
      undoable: true,
    };

    pendingGrade = null;
    state.queue.shift();
    activeContextIndex = 0;
    state.phase = "prompt";
    state.error = null;
    render();
    focusReveal();
    flushPending();
  }

  /** A turned card starts at its one action, not at the top of the panel. */
  function focusReveal(): void {
    if (destroyed) return;
    container.querySelector<HTMLElement>(".ilmt-review-input, .ilmt-review-grade, .ilmt-review-reveal")?.focus();
  }

  /**
   * One keyboard map for the whole review: grades, reveal, commit and undo.
   * It never runs while typing, while a modifier belongs to the browser, or
   * while the review is hidden behind the chat tab.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (destroyed || state.busy || event.defaultPrevented || event.repeat) return;
    if (!container.isConnected || Boolean(container.closest("[hidden]"))) return;
    if (event.isComposing || event.key === "Process") return;
    if (isEditableTarget(event.target)) return;
    if (event.altKey) return;

    if (!event.shiftKey && (event.key === "z" || event.key === "Z")) {
      if (state.receipt?.undoable && state.phase !== "lesson") {
        event.preventDefault();
        void undoLast();
      }
      return;
    }

    const word = current();
    if (!word) return;
    const choicesVisible =
      (state.phase === "prompt" && !isRecallCard(word)) || state.phase === "revealed";
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

    if (plain && (event.key === "1" || event.key === "ArrowRight")) {
      if (choicesVisible) {
        event.preventDefault();
        pickGrade("good");
      }
      return;
    }
    if (plain && (event.key === "2" || event.key === "ArrowLeft")) {
      if (choicesVisible) {
        event.preventDefault();
        pickGrade("again");
      }
      return;
    }
    if (plain && (event.key === " " || event.key === "Enter")) {
      if (isInteractiveTarget(event.target)) return;
      if (state.phase === "lesson") {
        event.preventDefault();
        void advance();
      } else if (isRecallCard(word) && state.phase === "prompt") {
        event.preventDefault();
        revealRecall(word.id);
      }
    }
  }

  /**
   * Undo the last committed card, once. The background restores the snapshot;
   * counts roll back here, and the queue is rebuilt from storage so the same
   * card returns in its prompt state.
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
    state.graduated = state.graduated.filter((word) => word.id !== receipt.id);
    state.answered = Math.max(0, state.answered - 1);
    if (receipt.grade === "again") state.missed = Math.max(0, state.missed - 1);
    // Undo brings the card back even after 结束, without resetting this round.
    state.ended = false;
    state.phase = "prompt";
    state.error = null;
    activeContextIndex = 0;
    render();
    await refresh();
    if (!destroyed) container.querySelector<HTMLElement>(".ilmt-review-card")?.focus();
  }

  /**
   * Ending drops the pending grade. The card stays due until confirmed.
   */
  async function endRound(): Promise<void> {
    if (state.busy) return;
    draft = "";
    state.ended = true;
    pendingGrade = null;
    // One explicit local read so "还有 N 个到期" is not a stale snapshot.
    try {
      state.all = await deps.getState();
    } catch {
      // Keep the last snapshot; the finish page can only tell the truth it has.
    }
    if (destroyed) return;
    state.queue = [];
    activeContextIndex = 0;
    state.phase = "prompt";
    state.error = null;
    render();
  }

  function flushPending(): void {
    if (!pendingReload) return;
    pendingReload = false;
    void refresh();
  }

  document.addEventListener("keydown", onKeydown);
  void refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      document.removeEventListener("keydown", onKeydown);
      sceneEffect?.destroy();
      sceneEffect = null;
      destroyGraduated();
      container.remove();
    },
  };
}
