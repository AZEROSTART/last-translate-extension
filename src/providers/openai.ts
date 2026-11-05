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

function isNamedError(err: unknown, name: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { name?: unknown }).name === name) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err && isNamedError(cause, name);
}

function isAbortError(err: unknown): boolean {
  return isNamedError(err, "AbortError");
}

function isTimeoutError(err: unknown): boolean {
  return isNamedError(err, "TimeoutError");
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
  if (isTimeoutError(err)) {
    return new ProviderError("timeout", `Request to ${url} timed out`, { cause: err });
  }
  if (isAbortError(err)) {
    return new ProviderError("aborted", redact(`Request aborted for ${url}`, cfg.apiKey), { cause: err });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ProviderError("network", redact(`Network error from ${url}: ${detail}`, cfg.apiKey), { cause: err });
}

/**
 * Race the fetch handshake against a connect deadline. The deadline is cleared
 * as soon as headers arrive, so a long-lived SSE response cannot be aborted by
 * the connect budget. The response body stays tied to `signal`, so caller and
 * total-timeout aborts still cancel in-flight reads.
 */
async function fetchWithConnectTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (signal?.aborted) throw new ProviderError("aborted", "Request aborted");

  const connectAbort = new AbortController();
  const onAbort = () => connectAbort.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const combined = signal ? AbortSignal.any([signal, connectAbort.signal]) : connectAbort.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connectDeadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderError("timeout", `Connection timed out after ${PROVIDER_TIMEOUTS.connectMs}ms`, { retryable: true }));
      connectAbort.abort();
    }, PROVIDER_TIMEOUTS.connectMs);
  });

  try {
    return await Promise.race([fetch(url, { ...init, signal: combined }), connectDeadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
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

  try {
    const response = await fetchWithConnectTimeout(
      url,
      { method: "GET", headers: buildHeaders(cfg, "GET") },
      signal,
    );
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
    throw mapFetchError(err, cfg, url, { callerAborted: signal?.aborted ?? false });
  }
}

/** One non-streaming completion. Retry policy lives in the queue (Task 7). */
export async function complete(cfg: ProviderConfig, req: CompletionRequest): Promise<CompletionResult> {
  const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`;
  const totalTimeout = AbortSignal.timeout(PROVIDER_TIMEOUTS.totalMs);
  const operationSignal = req.signal ? AbortSignal.any([req.signal, totalTimeout]) : totalTimeout;

  try {
    const response = await fetchWithConnectTimeout(
      url,
      {
        method: "POST",
        headers: buildHeaders(cfg, "POST"),
        body: JSON.stringify(buildBody(cfg, req, false)),
      },
      operationSignal,
    );
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

function hasFinishReason(payload: unknown): boolean {
  const choices = asObject(payload)?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some(choice => {
    const reason = asObject(choice)?.finish_reason;
    return typeof reason === "string" && reason.length > 0;
  });
}

function providerErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  const message = asObject(error)?.message;
  return typeof message === "string" ? message : undefined;
}

/**
 * Stream `POST {baseURL}/chat/completions` as text deltas.
 *
 * SSE events are buffered until a full `\n\n` delimiter arrives, so an event
 * split across chunks is never parsed early. Content from a trailing partial
 * event is never emitted. A stream must end with `[DONE]` or a `finish_reason`;
 * otherwise it is reported as a truncated `bad_response`.
 */
export async function* streamCompletion(cfg: ProviderConfig, req: CompletionRequest): AsyncGenerator<string> {
  const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`;
  const caller = req.signal;
  if (caller?.aborted) throw new ProviderError("aborted", redact(`Request aborted for ${url}`, cfg.apiKey));

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  caller?.addEventListener("abort", onCallerAbort, { once: true });

  let totalTimedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    controller.abort();
  }, PROVIDER_TIMEOUTS.totalMs);

  try {
    // The connect deadline is cleared when headers arrive; the 45s/60s/180s
    // budgets below govern the body. Never fold a connect timeout into the
    // response-body signal or every long stream would be truncated.
    const response = await fetchWithConnectTimeout(
      url,
      {
        method: "POST",
        headers: buildHeaders(cfg, "POST"),
        body: JSON.stringify(buildBody(cfg, req, true)),
      },
      controller.signal,
    );
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
    let terminated = false;

    while (true) {
      const timeoutMs = firstEvent ? PROVIDER_TIMEOUTS.firstTokenMs : PROVIDER_TIMEOUTS.idleMs;
      const result = await readWithTimeout(reader, timeoutMs, controller);
      if (result.done) {
        if (terminated) return;

        // A provider may omit the final blank line. Accept an unterminated
        // control marker, but never emit content from a trailing partial event.
        const tailPayload = eventData(buffer);
        if (tailPayload !== null) {
          if (tailPayload.trim() === "[DONE]") return;
          const tail = tryParseJson(tailPayload);
          if (tail !== undefined) {
            const tailObject = asObject(tail);
            if (tailObject?.error !== undefined) {
              const detail = redactedBody(
                providerErrorMessage(tailObject.error) ?? "Provider returned an error event",
              );
              throw new ProviderError("bad_response", redact(`Provider error from ${url}: ${detail}`, cfg.apiKey), {
                status: response.status,
              });
            }
            if (hasFinishReason(tail)) return;
          }
        }

        throw new ProviderError(
          "bad_response",
          redact(`Stream from ${url} ended before a completion marker`, cfg.apiKey),
          { status: response.status },
        );
      }

      // Keep the raw tail in `buffer`; only complete `\n\n`-delimited events are parsed.
      buffer = `${buffer}${decoder.decode(result.value, { stream: true })}`.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const payload = eventData(event);
        if (payload !== null && payload.trim().length > 0) {
          if (payload.trim() === "[DONE]") return;

          const parsed = tryParseJson(payload);
          if (parsed === undefined) {
            throw new ProviderError(
              "bad_response",
              redact(`Malformed SSE event from ${url}: ${redactedBody(payload)}`, cfg.apiKey),
              { status: response.status },
            );
          }

          const parsedObject = asObject(parsed);
          if (parsedObject?.error !== undefined) {
            const detail = redactedBody(providerErrorMessage(parsedObject.error) ?? "Provider returned an error event");
            throw new ProviderError("bad_response", redact(`Provider error from ${url}: ${detail}`, cfg.apiKey), {
              status: response.status,
            });
          }

          firstEvent = false;
          if (hasFinishReason(parsed)) terminated = true;
          const content = deltaContent(parsed);
          if (content !== undefined && content.length > 0) yield content;
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    throw mapFetchError(err, cfg, url, {
      timedOut: totalTimedOut,
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
