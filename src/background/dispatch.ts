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
  ProviderConfig,
  Settings,
  TranslateItem,
} from "../shared/types";
import { getActiveProvider, getSettings, DEFAULT_SETTINGS } from "../shared/storage";
import {
  buildTranslateMessages,
  groupSegments,
  parseNumberedResponse,
  PromptParseError,
} from "../shared/prompt";
import { ProviderError } from "../shared/errors";
import { buildCacheKey, TranslationCache } from "./cache";
import { RequestQueue } from "./queue";
import { getAdapter, type ProviderAdapter } from "../providers";

/** Grouping budget from spec §8.5. */
const GROUP_OPTS = { maxInputTokens: 1500, maxItems: 20 } as const;

/** Global retry policy from spec §8.6/§8.7. */
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1000, 3000] as const;

const NO_PROVIDER_MESSAGE = "未选择模型配置";
const EMPTY_TRANSLATION_MESSAGE = "模型返回了空译文";

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
  const settings = await deps.getSettings();
  const provider = getActiveProvider(settings);

  deps.queue.setLimits(
    clamp(provider?.overrides?.concurrency ?? settings.concurrency, 1, 10),
    clamp(provider?.overrides?.maxRPS ?? settings.maxRPS, 1, 20),
  );

  const allIds = msg.items.map((item) => item.id);

  if (!provider) {
    send({ type: "error", requestId, code: "bad_response", message: NO_PROVIDER_MESSAGE, retryable: false, ids: allIds });
    send({ type: "finish", requestId });
    return;
  }

  const systemPrompt = provider.overrides?.systemPrompt || settings.systemPrompt;
  const temperature = provider.overrides?.temperature ?? settings.temperature;

  const keyById = new Map<string, string>();
  const resultMap = new Map<string, string>();
  const misses: TranslateItem[] = [];

  for (const item of msg.items) {
    const key = await buildCacheKey({
      sourceText: item.text,
      targetLang: settings.targetLang,
      providerConfigId: provider.id,
      modelId: provider.model,
      promptVersion: settings.promptVersion,
    });
    const cached = await deps.cache.get(key);
    if (cached !== undefined && cached !== "") {
      resultMap.set(item.id, cached);
    } else {
      keyById.set(item.id, key);
      misses.push(item);
    }
  }

  const groups = groupSegments(misses, GROUP_OPTS);

  const outcomes = await Promise.all(
    groups.map((group) => {
      const groupIds = group.map((item) => item.id);
      return deps.queue
        .enqueue<Map<string, string>>({
          tabId: msg.tabId,
          priority: "translate",
          run: (signal) =>
            runGroup(deps, provider, group, groupIds, settings.targetLang, systemPrompt, temperature, requestId, signal, send),
        })
        .then(
          (map) => ({ ok: true as const, ids: groupIds, map }),
          (err: unknown) => ({ ok: false as const, ids: groupIds, err }),
        );
    }),
  );

  let aborted = false;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      for (const [id, text] of outcome.map) {
        const key = keyById.get(id);
        if (key) await deps.cache.put(key, text, { modelId: provider.model });
        resultMap.set(id, text);
      }
    } else if (isAborted(outcome.err)) {
      aborted = true;
    } else {
      const info = toErrorInfo(outcome.err);
      send({ type: "error", requestId, code: info.code, message: info.message, retryable: info.retryable, ids: outcome.ids });
    }
  }

  if (!aborted && resultMap.size > 0) {
    const items = msg.items
      .filter((item) => resultMap.has(item.id))
      .map((item) => ({ id: item.id, text: resultMap.get(item.id)! }));
    send({ type: "result", requestId, items });
  }
  if (!aborted) send({ type: "finish", requestId });
}

/**
 * Route one chat request through the same queue (chat priority) and stream the
 * reply. The system message is assembled from the page context; the user and
 * assistant history come from the message itself.
 */
export async function handleChat(
  deps: Deps,
  msg: Extract<ChatClientToBackground, { type: "chat" }>,
  send: (m: ChatBackgroundToClient) => void,
  tabId: number,
): Promise<void> {
  const requestId = msg.requestId;
  const settings = await deps.getSettings();
  const provider = getActiveProvider(settings);

  deps.queue.setLimits(
    clamp(provider?.overrides?.concurrency ?? settings.concurrency, 1, 10),
    clamp(provider?.overrides?.maxRPS ?? settings.maxRPS, 1, 20),
  );

  if (!provider) {
    send({ type: "error", requestId, code: "bad_response", message: NO_PROVIDER_MESSAGE, retryable: false });
    send({ type: "finish", requestId });
    return;
  }

  const temperature = provider.overrides?.temperature ?? settings.temperature;
  const messages: ChatMessage[] = [{ role: "system", content: buildChatSystemMessage(msg.context) }, ...msg.messages];

  const outcome = await deps.queue
    .enqueue<void>({
      tabId,
      priority: "chat",
      run: (signal) => runChat(deps, provider, messages, temperature, requestId, signal, send),
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
): Promise<Map<string, string>> {
  const messages = buildTranslateMessages(group, targetLang, systemPrompt);
  const single = group.length === 1 ? group[0].id : undefined;

  let lastRetryable: ProviderError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(RETRY_BACKOFF_MS[attempt - 1]);
    try {
      if (single !== undefined) {
        let joined = "";
        for await (const chunk of deps.adapter.streamCompletion(provider, { messages, temperature, signal })) {
          joined += chunk;
          send({ type: "delta", requestId, id: single, text: chunk });
        }
        if (joined.trim() === "") {
          throw new ProviderError("bad_response", EMPTY_TRANSLATION_MESSAGE, { retryable: false });
        }
        return new Map([[single, joined]]);
      }

      const result = await deps.adapter.complete(provider, { messages, temperature, signal });
      const map = parseNumberedResponse(result.text, ids);
      for (const text of map.values()) {
        if (text === "") {
          throw new ProviderError("bad_response", EMPTY_TRANSLATION_MESSAGE, { retryable: false });
        }
      }
      return map;
    } catch (err) {
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
  requestId: string,
  signal: AbortSignal,
  send: (m: ChatBackgroundToClient) => void,
): Promise<void> {
  let lastRetryable: ProviderError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(RETRY_BACKOFF_MS[attempt - 1]);
    try {
      for await (const chunk of deps.adapter.streamCompletion(provider, { messages, temperature, signal })) {
        send({ type: "delta", requestId, text: chunk });
      }
      return;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) {
        lastRetryable = err;
        continue;
      }
      throw err;
    }
  }
  throw lastRetryable!;
}

/** Assemble the chat system message from the page context (spec §8.9). */
function buildChatSystemMessage(ctx: ChatContext): string {
  const lines: string[] = [];
  lines.push(`当前页面标题：${ctx.title}`);
  lines.push(`当前页面 URL：${ctx.pageUrl}`);

  const recent = ctx.recentParagraphs.slice(-5);
  if (recent.length > 0) {
    lines.push("最近翻译的段落（最多 5 段）：");
    for (const p of recent) {
      lines.push(`- 原文：${p.source}`);
      lines.push(`  译文：${p.translation}`);
    }
  }

  if (ctx.quotes.length > 0) {
    lines.push("用户选中的引用：");
    for (const q of ctx.quotes) lines.push(`- ${q}`);
  }

  return lines.join("\n");
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
