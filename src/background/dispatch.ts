/**
 * Background translate/chat dispatch: cache → queue → provider adapter.
 *
 * Pure orchestration with injectable dependencies so it stays unit-testable
 * without any `chrome.*` access. `index.ts` owns the chrome wiring and passes
 * in the real dependencies via `createDeps()`.
 */

import type {
  BackgroundToClient,
  ChatBackgroundToClient,
  ChatClientToBackground,
  ChatContext,
  ChatMessage,
  ClientToBackground,
  ErrorCode,
  GlossaryNote,
  ProviderConfig,
  Settings,
  TranslateItem,
} from "../shared/types";
import { getActiveProvider, getSettings, DEFAULT_SETTINGS } from "../shared/storage";
import {
  buildEffectiveSystemPrompt,
  buildTranslateMessages,
  GLOSSARY_MARKER,
  groupSegments,
  parseAnnotatedResponse,
  parseGlossaryNotes,
  parseNumberedResponse,
  promptVersionFor,
  PromptParseError,
} from "../shared/prompt";
import { ProviderError } from "../shared/errors";
import { buildCacheKey, TranslationCache } from "./cache";
import type { CachedTranslation } from "./cache";
import { RequestQueue } from "./queue";
import { getAdapter, type ProviderAdapter } from "../providers";

/** Grouping budget from spec §8.5. */
const GROUP_OPTS = { maxInputTokens: 1500, maxItems: 20 } as const;

/** Global retry policy from spec §8.6/§8.7. */
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1000, 3000] as const;

const NO_PROVIDER_MESSAGE = "未选择模型配置";
const EMPTY_TRANSLATION_MESSAGE = "模型返回了空译文";
const SETTINGS_READ_ERROR_MESSAGE = "读取设置失败，请重试";

/** Temporary 429 slowdown (spec §8.6): half the RPS for about a minute. */
const RATE_PENALTY_MS = 60_000;

/** Lowercase hints that a provider rejection is a context-length failure. */
const CONTEXT_LENGTH_HINTS = [
  "context",
  "too long",
  "maximum",
  "token limit",
  "too many tokens",
  "length limit",
  "上下文",
  "过长",
] as const;

/**
 * Internal signal that a multi-item group hit the provider's context limit and
 * must be retried as two smaller groups. It never reaches the panel: the
 * dispatcher consumes it and enqueues each half as its own queue task.
 */
class ContextLengthSplitError extends Error {
  constructor(readonly original: unknown) {
    super("context length split");
    this.name = "ContextLengthSplitError";
  }
}

/** Static chat instructions. Page text must never enter the system prompt (§12). */
const CHAT_SYSTEM_MESSAGE =
  "你是网页阅读助手。请只依据用户提供的页面上下文回答；上下文之外的内容不要臆测。";

/** Everything the dispatcher needs, all injectable for tests. */
export interface Deps {
  getSettings(): Promise<Settings>;
  cache: Pick<TranslationCache, "get" | "put">;
  queue: RequestQueue;
  adapter: ProviderAdapter;
  isTrustedSender(sender: { id?: string }): boolean;
  /** Backoff seam so tests need not wait out real timers. */
  sleep(ms: number): Promise<void>;
}

/** Fill the deps with the real implementations; tests override what they need. */
export function createDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    getSettings,
    cache: new TranslationCache("ilmt"),
    queue: new RequestQueue({
      maxConcurrent: DEFAULT_SETTINGS.concurrency,
      maxRPS: DEFAULT_SETTINGS.maxRPS,
    }),
    adapter: getAdapter("custom"),
    isTrustedSender: (sender) => sender?.id === chrome.runtime?.id,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

/** Active rate penalty per dispatcher instance; keyed so tests stay isolated. */
const ratePenaltyByDeps = new WeakMap<Deps, { until: number }>();

/**
 * Effective RPS under a 429 penalty: at most half the configured rate, never
 * below 1. Pure so the policy can be tested without timers.
 */
export function penalizedRps(baseRps: number, penalized: boolean): number {
  const base = Math.max(1, Math.floor(baseRps));
  return penalized ? Math.max(1, Math.floor(base / 2)) : base;
}

/** A context-length rejection from the provider (spec §11). */
export function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  // 413 means the request body was too large; there is nothing to retry as-is.
  if (err.status === 413) return true;
  if (err.code !== "bad_response" && err.status !== 400) return false;
  const message = err.message.toLowerCase();
  return CONTEXT_LENGTH_HINTS.some((hint) => message.includes(hint));
}

/** Record a 429 penalty for the next dispatch start on this deps instance. */
function penalizeRate(deps: Deps): void {
  ratePenaltyByDeps.set(deps, { until: Date.now() + RATE_PENALTY_MS });
}

/**
 * Apply the settings-derived queue limits, halving the RPS while a recent
 * rate-limit penalty is active. Expired penalties are simply forgotten, so the
 * next request restores the configured limits.
 */
function applyQueueLimits(deps: Deps, provider: ProviderConfig | undefined, settings: Settings): void {
  const concurrency = clamp(provider?.overrides?.concurrency ?? settings.concurrency, 1, 10);
  const baseRps = clamp(provider?.overrides?.maxRPS ?? settings.maxRPS, 1, 20);

  const penalty = ratePenaltyByDeps.get(deps);
  const active = penalty !== undefined && penalty.until > Date.now();
  if (penalty !== undefined && !active) ratePenaltyByDeps.delete(deps);

  deps.queue.setLimits(concurrency, penalizedRps(baseRps, active));
}

/** The numbering prefix a model emits for a one-item group (spec §8.5). */
const SEGMENT_PREFIX = "[1]";

export interface SingleSegmentPrefixStripper {
  /** Feed one raw chunk; returns the stripped text to emit (possibly ""). */
  push(chunk: string): string;
  /** Flush any held characters once the stream has ended. */
  finish(): string;
}

/**
 * Strip the `[1] ` numbering prefix a model emits for a one-item group, so the
 * user never sees the prompt's index. Stateful: the prefix may arrive split
 * across stream chunks. Anything that does not match `^\[1\]\s*` passes through
 * untouched, and a partial prefix that diverges is flushed immediately rather
 * than swallowed.
 */
export function createSingleSegmentPrefixStripper(): SingleSegmentPrefixStripper {
  let matched = 0; // characters of SEGMENT_PREFIX confirmed so far
  let skippingWhitespace = false; // full prefix matched; eating trailing whitespace
  let pending = ""; // held characters that may still be the prefix
  let done = false; // prefix resolved; pass everything through

  function push(chunk: string): string {
    let out = "";
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];
      if (done) {
        out += chunk.slice(i);
        break;
      }
      if (skippingWhitespace) {
        if (/\s/.test(char)) continue;
        skippingWhitespace = false;
        done = true;
        out += char;
        continue;
      }
      if (char === SEGMENT_PREFIX[matched]) {
        matched += 1;
        pending += char;
        if (matched === SEGMENT_PREFIX.length) {
          pending = "";
          skippingWhitespace = true;
        }
        continue;
      }
      // Diverged before the full prefix matched: flush what we held plus this.
      out += pending + char;
      pending = "";
      done = true;
    }
    return out;
  }

  function finish(): string {
    const rest = pending;
    pending = "";
    return rest;
  }

  return { push, finish };
}

/** Translation plus the optional annotations returned with it. */
export interface TranslationOutput {
  text: string;
  glossary: GlossaryNote[];
}

export interface AnnotatedStreamFilter {
  /** Feed one raw chunk; returns text safe to emit now (possibly ""). */
  push(chunk: string): string;
  /** Finish the stream and return the complete translation plus note JSON. */
  finish(): { text: string; notesRaw: string };
}

/**
 * Streaming filter for a one-item annotated response. It strips `[1] `, emits
 * ordinary text immediately, and holds back only a suffix that could still be
 * the beginning of the glossary marker. Once the full marker arrives, all
 * following characters are collected as raw notes JSON.
 */
export function createAnnotatedStreamFilter(): AnnotatedStreamFilter {
  const prefix = createSingleSegmentPrefixStripper();
  let text = "";
  let pending = "";
  let notesRaw = "";
  let inNotes = false;

  function markerPrefixLength(value: string): number {
    const max = Math.min(GLOSSARY_MARKER.length - 1, value.length);
    for (let length = max; length > 0; length -= 1) {
      if (value.endsWith(GLOSSARY_MARKER.slice(0, length))) return length;
    }
    return 0;
  }

  function consume(chunk: string): string {
    if (inNotes) {
      notesRaw += chunk;
      return "";
    }

    pending += chunk;
    const markerIndex = pending.indexOf(GLOSSARY_MARKER);
    if (markerIndex >= 0) {
      const emit = pending.slice(0, markerIndex);
      text += emit;
      notesRaw = pending.slice(markerIndex + GLOSSARY_MARKER.length);
      pending = "";
      inNotes = true;
      return emit;
    }

    const hold = markerPrefixLength(pending);
    const emit = pending.slice(0, pending.length - hold);
    pending = pending.slice(pending.length - hold);
    text += emit;
    return emit;
  }

  function push(chunk: string): string {
    return consume(prefix.push(chunk));
  }

  function finish(): { text: string; notesRaw: string } {
    consume(prefix.finish());
    if (!inNotes) {
      text += pending;
      pending = "";
    }
    return { text, notesRaw: notesRaw.trim() };
  }

  return { push, finish };
}

/**
 * Route one translate request: look up the cache, group the misses, run each
 * group through the shared queue (with the global retry policy), and report
 * results, deltas and errors. A group failure never stops the other groups.
 */
export async function handleTranslate(
  deps: Deps,
  msg: Extract<ClientToBackground, { type: "translate" }>,
  send: (m: BackgroundToClient) => void,
): Promise<void> {
  const requestId = msg.requestId;
  const allIds = msg.items.map((item) => item.id);

  let settings: Settings;
  try {
    settings = await deps.getSettings();
  } catch {
    // A storage failure must still settle the request; otherwise every record
    // stays inflight and the page never shows the failure.
    send({
      type: "error",
      requestId,
      code: "bad_response",
      message: SETTINGS_READ_ERROR_MESSAGE,
      retryable: false,
      ids: allIds,
    });
    send({ type: "finish", requestId });
    return;
  }

  const provider = getActiveProvider(settings);
  applyQueueLimits(deps, provider, settings);

  if (!provider) {
    send({ type: "error", requestId, code: "bad_response", message: NO_PROVIDER_MESSAGE, retryable: false, ids: allIds });
    send({ type: "finish", requestId });
    return;
  }

  const glossaryEnabled = settings.glossaryEnabled !== false;
  const baseSystemPrompt = provider.overrides?.systemPrompt?.trim()
    ? provider.overrides.systemPrompt
    : settings.systemPrompt.trim()
      ? settings.systemPrompt
      : DEFAULT_SETTINGS.systemPrompt;
  const systemPrompt = buildEffectiveSystemPrompt(baseSystemPrompt, glossaryEnabled);
  const promptVersion = await promptVersionFor(systemPrompt);
  const temperature = provider.overrides?.temperature ?? settings.temperature;

  const keyById = new Map<string, string>();
  const resultMap = new Map<string, TranslationOutput>();
  const misses: TranslateItem[] = [];

  for (const item of msg.items) {
    const key = await buildCacheKey({
      sourceText: item.text,
      targetLang: settings.targetLang,
      providerConfigId: provider.id,
      modelId: provider.model,
      promptVersion,
    });
    let cached: CachedTranslation | undefined;
    try {
      cached = await deps.cache.get(key);
    } catch {
      // A cache read failure is simply a miss; the provider can still answer.
      cached = undefined;
    }
    if (cached !== undefined && cached.text !== "") {
      resultMap.set(item.id, { text: cached.text, glossary: cached.glossary ?? [] });
    } else {
      keyById.set(item.id, key);
      misses.push(item);
    }
  }

  const groups = groupSegments(misses, GROUP_OPTS);

  // Run each group as one queue task first. A context-length failure comes back
  // as a split signal; only after the parent task has settled do we enqueue the
  // halves, so a concurrency-1 queue cannot deadlock waiting on itself.
  const parentOutcomes = await Promise.all(
    groups.map((group) =>
      enqueueTranslateGroup(
        deps,
        provider,
        group,
        settings.targetLang,
        systemPrompt,
        temperature,
        requestId,
        msg.tabId,
        send,
        true,
        glossaryEnabled,
      ),
    ),
  );

  const outcomes: GroupOutcome[] = [];
  for (let i = 0; i < parentOutcomes.length; i += 1) {
    const outcome = parentOutcomes[i];
    if (!outcome.ok && outcome.err instanceof ContextLengthSplitError) {
      const group = groups[i];
      const mid = Math.ceil(group.length / 2);
      const halves = [group.slice(0, mid), group.slice(mid)];
      const halfOutcomes = await Promise.all(
        halves.map((half) =>
          enqueueTranslateGroup(
            deps,
            provider,
            half,
            settings.targetLang,
            systemPrompt,
            temperature,
            requestId,
            msg.tabId,
            send,
            false,
            glossaryEnabled,
          ),
        ),
      );
      outcomes.push(...halfOutcomes);
    } else {
      outcomes.push(outcome);
    }
  }

  let aborted = false;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      for (const [id, output] of outcome.map) {
        const key = keyById.get(id);
        if (key) {
          try {
            await deps.cache.put(key, output, { modelId: provider.model });
          } catch {
            // A cache write failure is non-fatal: still deliver the result.
          }
        }
        resultMap.set(id, output);
      }
    } else if (isAborted(outcome.err)) {
      aborted = true;
    } else {
      const info = toErrorInfo(outcome.err);
      if (info.code === "rate_limit") penalizeRate(deps);
      send({ type: "error", requestId, code: info.code, message: info.message, retryable: info.retryable, ids: outcome.ids });
    }
  }

  if (!aborted && resultMap.size > 0) {
    const items = msg.items
      .filter((item) => resultMap.has(item.id))
      .map((item) => {
        const output = resultMap.get(item.id)!;
        return output.glossary.length > 0
          ? { id: item.id, text: output.text, glossary: output.glossary }
          : { id: item.id, text: output.text };
      });
    send({ type: "result", requestId, items });
  }
  if (!aborted) send({ type: "finish", requestId });
}

/** Result of one queued translate group, normalized so callers merge halves. */
type GroupOutcome =
  | { ok: true; ids: string[]; map: Map<string, TranslationOutput> }
  | { ok: false; ids: string[]; err: unknown };

/**
 * Queue one translate group as its own task. `allowSplit` is true only for the
 * original group: a split half that is still too long fails normally.
 */
function enqueueTranslateGroup(
  deps: Deps,
  provider: ProviderConfig,
  group: TranslateItem[],
  targetLang: string,
  systemPrompt: string,
  temperature: number,
  requestId: string,
  tabId: number,
  send: (m: BackgroundToClient) => void,
  allowSplit: boolean,
  glossaryEnabled: boolean,
): Promise<GroupOutcome> {
  const ids = group.map((item) => item.id);
  return deps.queue
    .enqueue<Map<string, TranslationOutput>>({
      tabId,
      priority: "translate",
      run: (signal) =>
        runGroup(
          deps,
          provider,
          group,
          ids,
          targetLang,
          systemPrompt,
          temperature,
          requestId,
          signal,
          send,
          allowSplit,
          glossaryEnabled,
        ),
    })
    .then(
      (map) => ({ ok: true as const, ids, map }),
      (err: unknown) => ({ ok: false as const, ids, err }),
    );
}

/**
 * Route one chat request through the same queue (chat priority) and stream the
 * reply. The system message is static; page context is user-message content
 * (spec §12) and the conversation history comes from the message itself.
 */
export async function handleChat(
  deps: Deps,
  msg: Extract<ChatClientToBackground, { type: "chat" }>,
  send: (m: ChatBackgroundToClient) => void,
  tabId: number,
): Promise<void> {
  const requestId = msg.requestId;

  let settings: Settings;
  try {
    settings = await deps.getSettings();
  } catch {
    send({
      type: "error",
      requestId,
      code: "bad_response",
      message: SETTINGS_READ_ERROR_MESSAGE,
      retryable: false,
    });
    send({ type: "finish", requestId });
    return;
  }

  const provider = getActiveProvider(settings);
  applyQueueLimits(deps, provider, settings);

  if (!provider) {
    send({ type: "error", requestId, code: "bad_response", message: NO_PROVIDER_MESSAGE, retryable: false });
    send({ type: "finish", requestId });
    return;
  }

  const temperature = provider.overrides?.temperature ?? settings.temperature;
  const messages = buildChatMessages(msg.context, msg.messages);

  const outcome = await deps.queue
    .enqueue<void>({
      tabId,
      priority: "chat",
      run: (signal) =>
        runChat(deps, provider, messages, temperature, msg.thinking, requestId, signal, send),
    })
    .then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );

  if (outcome.ok) {
    send({ type: "finish", requestId });
  } else if (!isAborted(outcome.err)) {
    const info = toErrorInfo(outcome.err);
    send({ type: "error", requestId, code: info.code, message: info.message, retryable: info.retryable });
    send({ type: "finish", requestId });
  }
}

/** Run one translate group with the global retry policy; single items stream. */
async function runGroup(
  deps: Deps,
  provider: ProviderConfig,
  group: TranslateItem[],
  ids: string[],
  targetLang: string,
  systemPrompt: string,
  temperature: number,
  requestId: string,
  signal: AbortSignal,
  send: (m: BackgroundToClient) => void,
  allowSplit: boolean,
  glossaryEnabled: boolean,
): Promise<Map<string, TranslationOutput>> {
  const messages = buildTranslateMessages(group, targetLang, systemPrompt);
  const single = group.length === 1 ? group[0].id : undefined;

  let lastRetryable: ProviderError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(RETRY_BACKOFF_MS[attempt - 1]);
    try {
      if (single !== undefined) {
        if (glossaryEnabled) {
          const filter = createAnnotatedStreamFilter();
          for await (const chunk of deps.adapter.streamCompletion(provider, { messages, temperature, signal })) {
            const text = filter.push(chunk);
            if (text !== "") send({ type: "delta", requestId, id: single, text });
          }
          const { text: joined, notesRaw } = filter.finish();
          if (joined.trim() === "") {
            throw new ProviderError("bad_response", EMPTY_TRANSLATION_MESSAGE, { retryable: false });
          }
          const glossary = parseGlossaryNotes(notesRaw, group).get(single) ?? [];
          return new Map([[single, { text: joined, glossary }]]);
        }

        const strip = createSingleSegmentPrefixStripper();
        let joined = "";
        for await (const chunk of deps.adapter.streamCompletion(provider, { messages, temperature, signal })) {
          const text = strip.push(chunk);
          if (text !== "") {
            joined += text;
            send({ type: "delta", requestId, id: single, text });
          }
        }
        joined += strip.finish();
        if (joined.trim() === "") {
          throw new ProviderError("bad_response", EMPTY_TRANSLATION_MESSAGE, { retryable: false });
        }
        return new Map([[single, { text: joined, glossary: [] }]]);
      }

      const result = await deps.adapter.complete(provider, { messages, temperature, signal });
      if (glossaryEnabled) {
        const parsed = parseAnnotatedResponse(result.text, group);
        const map = new Map<string, TranslationOutput>();
        for (const item of group) {
          const text = parsed.translations.get(item.id)!;
          if (text === "") {
            throw new ProviderError("bad_response", EMPTY_TRANSLATION_MESSAGE, { retryable: false });
          }
          map.set(item.id, { text, glossary: parsed.glossary.get(item.id) ?? [] });
        }
        return map;
      }

      const map = parseNumberedResponse(result.text, ids);
      const outputs = new Map<string, TranslationOutput>();
      for (const [id, text] of map) {
        if (text === "") {
          throw new ProviderError("bad_response", EMPTY_TRANSLATION_MESSAGE, { retryable: false });
        }
        outputs.set(id, { text, glossary: [] });
      }
      return outputs;
    } catch (err) {
      // Spec §11: an over-long original group is handed back to the dispatcher,
      // which re-queues each half as its own task. A single-item group or an
      // already-split half has nowhere smaller to go, so it fails normally.
      if (isContextLengthError(err) && group.length > 1 && allowSplit) {
        throw new ContextLengthSplitError(err);
      }
      if (err instanceof ProviderError && err.retryable) {
        lastRetryable = err;
        continue;
      }
      throw err;
    }
  }
  throw lastRetryable!;
}

/** Stream one chat reply with the global retry policy. */
async function runChat(
  deps: Deps,
  provider: ProviderConfig,
  messages: ChatMessage[],
  temperature: number,
  thinking: boolean | undefined,
  requestId: string,
  signal: AbortSignal,
  send: (m: ChatBackgroundToClient) => void,
): Promise<void> {
  let lastRetryable: ProviderError | undefined;
  let emitted = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(RETRY_BACKOFF_MS[attempt - 1]);
    try {
      for await (const chunk of deps.adapter.streamCompletion(provider, {
        messages,
        temperature,
        thinking,
        signal,
        // Spec §8.9 sets no total deadline for chat; connect/first-token/idle
        // still guard a dead stream.
        totalTimeoutMs: null,
      })) {
        emitted = true;
        send({ type: "delta", requestId, text: chunk });
      }
      return;
    } catch (err) {
      // Once any text has reached the panel, a retry would append the prefix
      // twice. Propagate the failure instead; the partial answer stays visible.
      if (!emitted && err instanceof ProviderError && err.retryable) {
        lastRetryable = err;
        continue;
      }
      throw err;
    }
  }
  throw lastRetryable!;
}

/**
 * Page context as user-message content, never system instructions (§12).
 * Only the latest user turn gets the context; earlier turns stay untouched so
 * a multi-turn conversation reads naturally.
 */
function buildPageContextBlock(ctx: ChatContext): string {
  const lines: string[] = ["【页面上下文】"];
  lines.push(`标题：${ctx.title}`);
  lines.push(`URL：${ctx.pageUrl}`);

  if (ctx.selectionContext) {
    const selection = ctx.selectionContext;
    lines.push("【选中位置上下文】");
    if (selection.heading) lines.push(`所在标题：${selection.heading}`);
    if (selection.preceding.length > 0) {
      lines.push("前面段落：");
      for (const paragraph of selection.preceding) lines.push(`- ${paragraph}`);
    }
    lines.push("当前段落：");
    lines.push(selection.paragraph);
  }

  const recent = ctx.recentParagraphs.slice(-5);
  if (recent.length > 0) {
    lines.push("最近段落（最多 5 段）：");
    for (const p of recent) {
      lines.push(`- 原文：${p.source}`);
      lines.push(`  译文：${p.translation}`);
    }
  }

  if (ctx.quotes.length > 0) {
    lines.push("选中引用：");
    for (const q of ctx.quotes) lines.push(`- ${q}`);
  }

  return lines.join("\n");
}

/** Static system instructions plus history with the page context attached. */
export function buildChatMessages(context: ChatContext, history: ChatMessage[]): ChatMessage[] {
  const messages = history.map((message) => ({ ...message }));
  const contextBlock = buildPageContextBlock(context);

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }

  if (lastUser === -1) {
    messages.push({ role: "user", content: `${contextBlock}\n\n【问题】\n` });
  } else {
    messages[lastUser] = {
      role: "user",
      content: `${contextBlock}\n\n【问题】\n${messages[lastUser].content}`,
    };
  }

  return [{ role: "system", content: CHAT_SYSTEM_MESSAGE }, ...messages];
}

/** Normalize a thrown value into an error message payload. */
function toErrorInfo(err: unknown): { code: ErrorCode; message: string; retryable: boolean } {
  if (err instanceof ProviderError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof PromptParseError) {
    return { code: "bad_response", message: err.message, retryable: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "unknown", message, retryable: false };
}

/** Recognize the tab-cancellation signal from both the queue and the adapter. */
function isAborted(err: unknown): boolean {
  if (err instanceof ProviderError) return err.code === "aborted";
  return err instanceof Error && err.message === "aborted";
}

/** Range-clamp a numeric setting to its documented limits. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
