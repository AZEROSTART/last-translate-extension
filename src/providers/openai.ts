import { ProviderError } from "../shared/errors";
import type { ChatUsage, ErrorCode, ModelInfo, ProviderConfig } from "../shared/types";
import type { CompletionRequest, CompletionResult } from "./types";

/**
 * Timeout budgets from spec §8.6. Connect applies to the fetch handshake;
 * first-token/idle are enforced with manual timers while reading SSE.
 */
export const PROVIDER_TIMEOUTS = {
  connectMs: 15_000,
  firstTokenMs: 45_000,
  idleMs: 60_000,
  totalMs: 180_000,
} as const;

const MAX_ERROR_BODY = 300;

/** Remove an API key from anything user-visible. */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

/**
 * Trim whitespace/trailing slashes and append `/v1` unless it is already the
 * final path segment. Users may disable the suffix for gateways that do not
 * use it.
 */
export function normalizeBaseURL(raw: string, opts: { appendV1?: boolean } = {}): string {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) return "";
  return opts.appendV1 !== false && !url.endsWith("/v1") ? `${url}/v1` : url;
}

function putHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing !== name && existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }
  headers[name] = value;
}

/**
 * Build request headers: `Authorization` first, then `Content-Type` for
 * non-GET requests, then `extraHeaders` (case-insensitive override) with
 * `{{apiKey}}` substituted.
 */
export function buildHeaders(cfg: ProviderConfig, method: string = "POST"): Record<string, string> {
  const headers: Record<string, string> = {};
  headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  if (method.toUpperCase() !== "GET") headers["Content-Type"] = "application/json";

  for (const [name, rawValue] of Object.entries(cfg.extraHeaders ?? {})) {
    putHeader(headers, name, rawValue.split("{{apiKey}}").join(cfg.apiKey));
  }
  return headers;
}

function classifyStatus(status: number): { code: ErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "auth", retryable: false };
  if (status === 429) return { code: "rate_limit", retryable: true };
  if (status >= 500) return { code: "network", retryable: true };
  return { code: "bad_response", retryable: false };
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { name?: unknown }).name === "AbortError") return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err && isAbortError(cause);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function redactedBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_BODY);
}

async function httpError(cfg: ProviderConfig, response: Response, url: string): Promise<ProviderError> {
  const { code, retryable } = classifyStatus(response.status);
  let detail = "";
  try {
    const body = await response.text();
    if (body) detail = `: ${redactedBody(body)}`;
  } catch {
    // The body is optional context; never mask the status-based error.
  }
  return new ProviderError(code, redact(`HTTP ${response.status} from ${url}${detail}`, cfg.apiKey), {
    retryable,
    status: response.status,
  });
}

async function readJson(cfg: ProviderConfig, response: Response, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ProviderError("bad_response", redact(`Invalid JSON response from ${url}`, cfg.apiKey), {
      status: response.status,
      cause: err,
    });
  }
}

interface ErrorContext {
  timedOut?: boolean;
  callerAborted?: boolean;
}

function mapFetchError(err: unknown, cfg: ProviderConfig, url: string, ctx: ErrorContext = {}): ProviderError {
  if (err instanceof ProviderError) return err;
  if (ctx.callerAborted) {
    return new ProviderError("aborted", redact(`Request aborted for ${url}`, cfg.apiKey), { cause: err });
  }
  if (ctx.timedOut) {
    return new ProviderError("timeout", `Request to ${url} timed out`, { cause: err });
  }
  if (isAbortError(err)) {
    return new ProviderError("aborted", redact(`Request aborted for ${url}`, cfg.apiKey), { cause: err });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ProviderError("network", redact(`Network error from ${url}: ${detail}`, cfg.apiKey), { cause: err });
}

function parseUsage(raw: unknown): ChatUsage | undefined {
  const usage = asObject(raw);
  if (!usage) return undefined;

  const result: ChatUsage = {};
  if (typeof usage.prompt_tokens === "number") result.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") result.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") result.totalTokens = usage.total_tokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildBody(cfg: ProviderConfig, req: CompletionRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model ?? cfg.model,
    messages: req.messages,
    stream,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  return body;
}

function deltaContent(payload: unknown): string | undefined {
  const choices = asObject(payload)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const content = asObject(asObject(choices[0])?.delta)?.content;
  return typeof content === "string" ? content : undefined;
}

/** Concatenate the `data:` lines of one SSE event, or null for comments/other fields. */
function eventData(event: string): string | null {
  const lines: string[] = [];
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let value = line.slice("data:".length);
    if (value.startsWith(" ")) value = value.slice(1);
    lines.push(value);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProviderError("timeout", `Stream stalled for more than ${timeoutMs}ms`, { retryable: true }));
      controller.abort();
    }, timeoutMs);

    reader.read().then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** `GET {baseURL}/models`; a failure here must never block the settings UI. */
export async function listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  const url = `${normalizeBaseURL(cfg.baseURL)}/models`;
  const connectTimeout = AbortSignal.timeout(PROVIDER_TIMEOUTS.connectMs);
  const combined = signal ? AbortSignal.any([signal, connectTimeout]) : connectTimeout;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(cfg, "GET"),
      signal: combined,
    });
    if (!response.ok) throw await httpError(cfg, response, url);

    const data = await readJson(cfg, response, url);
    const items = asObject(data)?.data;
    if (!Array.isArray(items)) {
      throw new ProviderError("bad_response", redact(`Malformed model list from ${url}`, cfg.apiKey), {
        status: response.status,
      });
    }

    const models: ModelInfo[] = [];
    for (const item of items) {
      const obj = asObject(item);
      const id = obj?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const ownedBy = obj?.owned_by;
      models.push(typeof ownedBy === "string" ? { id, ownedBy } : { id });
    }
    return models;
  } catch (err) {
    throw mapFetchError(err, cfg, url, { timedOut: connectTimeout.aborted, callerAborted: signal?.aborted ?? false });
  }
}

/** One non-streaming completion. Retry policy lives in the queue (Task 7). */
export async function complete(cfg: ProviderConfig, req: CompletionRequest): Promise<CompletionResult> {
  const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`;
  const totalTimeout = AbortSignal.timeout(PROVIDER_TIMEOUTS.totalMs);
  const combined = req.signal ? AbortSignal.any([req.signal, totalTimeout]) : totalTimeout;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(cfg, "POST"),
      body: JSON.stringify(buildBody(cfg, req, false)),
      signal: combined,
    });
    if (!response.ok) throw await httpError(cfg, response, url);

    const data = asObject(await readJson(cfg, response, url));
    const choices = data?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderError("bad_response", redact(`Missing choices in response from ${url}`, cfg.apiKey), {
        status: response.status,
      });
    }

    const content = asObject(asObject(choices[0])?.message)?.content;
    if (typeof content !== "string") {
      throw new ProviderError("bad_response", redact(`Missing message content in response from ${url}`, cfg.apiKey), {
        status: response.status,
      });
    }

    const usage = parseUsage(data?.usage);
    return usage ? { text: content, usage } : { text: content };
  } catch (err) {
    throw mapFetchError(err, cfg, url, {
      timedOut: totalTimeout.aborted,
      callerAborted: req.signal?.aborted ?? false,
    });
  }
}

/**
 * Stream `POST {baseURL}/chat/completions` as text deltas.
 *
 * SSE events are buffered until a full `\n\n` delimiter arrives, so an event
 * split across chunks is never parsed early. A trailing partial event at EOF
 * is intentionally discarded.
 */
export async function* streamCompletion(cfg: ProviderConfig, req: CompletionRequest): AsyncGenerator<string> {
  const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`;
  const caller = req.signal;
  if (caller?.aborted) throw new ProviderError("aborted", redact(`Request aborted for ${url}`, cfg.apiKey));

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  caller?.addEventListener("abort", onCallerAbort, { once: true });

  const connectTimeout = AbortSignal.timeout(PROVIDER_TIMEOUTS.connectMs);
  const signal = AbortSignal.any([controller.signal, connectTimeout]);
  let connected = false;
  let totalTimedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    controller.abort();
  }, PROVIDER_TIMEOUTS.totalMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(cfg, "POST"),
      body: JSON.stringify(buildBody(cfg, req, true)),
      signal,
    });
    connected = true;
    if (!response.ok) throw await httpError(cfg, response, url);
    if (!response.body) {
      throw new ProviderError("bad_response", redact(`Empty response body from ${url}`, cfg.apiKey), {
        status: response.status,
      });
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstEvent = true;

    while (true) {
      const timeoutMs = firstEvent ? PROVIDER_TIMEOUTS.firstTokenMs : PROVIDER_TIMEOUTS.idleMs;
      const result = await readWithTimeout(reader, timeoutMs, controller);
      if (result.done) return;

      // Keep the raw tail in `buffer`; only complete `\n\n`-delimited events are parsed.
      buffer = `${buffer}${decoder.decode(result.value, { stream: true })}`.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const payload = eventData(event);
        if (payload !== null) {
          if (payload.trim() === "[DONE]") return;
          const parsed = tryParseJson(payload);
          if (parsed !== undefined) {
            firstEvent = false;
            const content = deltaContent(parsed);
            if (content !== undefined && content.length > 0) yield content;
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    throw mapFetchError(err, cfg, url, {
      timedOut: totalTimedOut || (!connected && connectTimeout.aborted),
      callerAborted: caller?.aborted ?? false,
    });
  } finally {
    clearTimeout(totalTimer);
    caller?.removeEventListener("abort", onCallerAbort);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Already closed or aborted.
      }
    }
  }
}
