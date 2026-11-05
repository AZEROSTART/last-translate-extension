import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeBaseURL, buildHeaders, listModels, complete, streamCompletion, PROVIDER_TIMEOUTS } from "../../src/providers/openai";
import { getAdapter } from "../../src/providers/index";
import { ProviderError } from "../../src/shared/errors";
import type { ProviderConfig } from "../../src/shared/types";
import type { CompletionRequest } from "../../src/providers/types";

const cfg: ProviderConfig = {
  id: "a",
  name: "A",
  kind: "custom",
  baseURL: "https://api.test",
  apiKey: "sk-1",
  model: "m",
  createdAt: 1,
};

const req = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "m",
  messages: [],
  temperature: 0,
  signal: new AbortController().signal,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function streamResponse(parts: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < parts.length) c.enqueue(enc.encode(parts[i++]));
      else c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(handler);
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const delta of gen) out += delta;
  return out;
}

async function captureError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    return err as ProviderError;
  }
  throw new Error("Expected the promise to reject");
}

async function collectWithError(
  gen: AsyncGenerator<string>,
): Promise<{ deltas: string[]; error?: ProviderError }> {
  const deltas: string[] = [];
  try {
    for await (const delta of gen) deltas.push(delta);
    return { deltas };
  } catch (err) {
    return { deltas, error: err as ProviderError };
  }
}

describe("normalizeBaseURL", () => {
  it("appends /v1 by default", () => {
    expect(normalizeBaseURL("https://api.test")).toBe("https://api.test/v1");
  });

  it("keeps an existing /v1", () => {
    expect(normalizeBaseURL("https://api.test/v1/")).toBe("https://api.test/v1");
  });

  it("can be disabled", () => {
    expect(normalizeBaseURL("https://api.test", { appendV1: false })).toBe("https://api.test");
  });

  it("trims whitespace and redundant trailing slashes", () => {
    expect(normalizeBaseURL("  https://api.test/proxy///  ")).toBe("https://api.test/proxy/v1");
  });
});

describe("buildHeaders", () => {
  it("merges extra headers and substitutes the key", () => {
    const h = buildHeaders({ ...cfg, extraHeaders: { "HTTP-Referer": "https://app.test", "X-Token": "{{apiKey}}" } });
    expect(h["Authorization"]).toBe("Bearer sk-1");
    expect(h["HTTP-Referer"]).toBe("https://app.test");
    expect(h["X-Token"]).toBe("sk-1");
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("omits Content-Type for GET", () => {
    expect(buildHeaders(cfg, "GET")["Content-Type"]).toBeUndefined();
  });

  it("lets extra headers override Authorization regardless of casing", () => {
    const h = buildHeaders({ ...cfg, extraHeaders: { authorization: "Bearer other" } });
    expect(h["authorization"]).toBe("Bearer other");
    expect(h["Authorization"]).toBeUndefined();
  });
});

describe("listModels", () => {
  it("returns ids", async () => {
    mockFetch(async () => new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 }));
    const models = await listModels(cfg);
    expect(models.map(m => m.id)).toEqual(["m1", "m2"]);
  });

  it("sends a GET with auth headers to the normalized URL", async () => {
    const fn = mockFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await listModels(cfg);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/models");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-1");
  });

  it("omits /v1 when appendV1 is false", async () => {
    const fn = mockFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await listModels({ ...cfg, appendV1: false });
    expect(fn.mock.calls[0][0]).toBe("https://api.test/models");
  });

  it("maps 401 to a non-retryable auth error", async () => {
    mockFetch(async () => new Response("{}", { status: 401 }));
    await expect(listModels(cfg)).rejects.toMatchObject({ code: "auth", retryable: false, status: 401 });
  });

  it.each([
    [403, "auth", false],
    [429, "rate_limit", true],
    [500, "network", true],
    [503, "network", true],
    [400, "bad_response", false],
    [404, "bad_response", false],
  ] as const)("classifies HTTP %i as %s (retryable=%s)", async (status, code, retryable) => {
    mockFetch(async () => new Response("{}", { status }));
    await expect(listModels(cfg)).rejects.toMatchObject({ code, retryable, status });
  });

  it("classifies a network failure as retryable", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(listModels(cfg)).rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("classifies an aborted request as non-retryable", async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch(async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(listModels(cfg, controller.signal)).rejects.toMatchObject({ code: "aborted", retryable: false });
  });

  it("never leaks the API key in an error message", async () => {
    mockFetch(async () => new Response(`invalid key ${cfg.apiKey}`, { status: 401 }));
    const err = await captureError(listModels(cfg));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("auth");
    expect(err.message).not.toContain(cfg.apiKey);
    expect(err.message).toContain("[redacted]");
  });

  it("rejects a malformed model list as bad_response", async () => {
    mockFetch(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(listModels(cfg)).rejects.toMatchObject({ code: "bad_response", retryable: false });
  });
});

describe("complete", () => {
  it("returns message content", async () => {
    mockFetch(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "甲" } }] }), { status: 200 }),
    );
    await expect(complete(cfg, req({ messages: [{ role: "user", content: "[1] a" }] }))).resolves.toEqual({ text: "甲" });
  });

  it("omits /v1 for completions when appendV1 is false", async () => {
    const fn = mockFetch(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "甲" } }] }), { status: 200 }),
    );
    await complete({ ...cfg, appendV1: false }, req());
    expect(fn.mock.calls[0][0]).toBe("https://api.test/chat/completions");
  });

  it("sends a non-streaming request and forwards usage", async () => {
    const fn = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "乙" } }],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }),
          { status: 200 },
        ),
    );
    const result = await complete(cfg, req({ messages: [{ role: "user", content: "hi" }] }));
    expect(result).toEqual({
      text: "乙",
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    });
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      stream: false,
    });
  });

  it("classifies 429 as retryable", async () => {
    mockFetch(async () => new Response("{}", { status: 429 }));
    await expect(complete(cfg, req())).rejects.toMatchObject({ code: "rate_limit", retryable: true });
  });

  it("treats a missing choices array as bad_response", async () => {
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(complete(cfg, req())).rejects.toMatchObject({ code: "bad_response", retryable: false });
  });
});

describe("streamCompletion", () => {
  it("parses SSE split across chunk boundaries", async () => {
    mockFetch(async () =>
      streamResponse([
        'data: {"choices":[{"del',
        'ta":{"content":"你"}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    expect(await collect(streamCompletion(cfg, req()))).toBe("你好");
  });

  it("does not emit a trailing partial event and rejects the truncated stream", async () => {
    mockFetch(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
      ]),
    );
    const { deltas, error } = await collectWithError(streamCompletion(cfg, req()));
    expect(deltas).toEqual(["你"]);
    expect(error).toMatchObject({ code: "bad_response", retryable: false });
  });

  it("rejects a clean EOF that arrives without [DONE] or finish_reason", async () => {
    mockFetch(async () =>
      streamResponse(['data: {"choices":[{"delta":{"content":"你"}}]}\n\n']),
    );
    const { deltas, error } = await collectWithError(streamCompletion(cfg, req()));
    expect(deltas).toEqual(["你"]);
    expect(error).toMatchObject({ code: "bad_response", retryable: false });
  });

  it("accepts finish_reason as a terminator when [DONE] is absent", async () => {
    mockFetch(async () =>
      streamResponse(['data: {"choices":[{"delta":{"content":"你"},"finish_reason":"stop"}]}\n\n']),
    );
    expect(await collect(streamCompletion(cfg, req()))).toBe("你");
  });

  it("accepts a final [DONE] even when its blank line is missing", async () => {
    mockFetch(async () =>
      streamResponse(['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', "data: [DONE]"]),
    );
    expect(await collect(streamCompletion(cfg, req()))).toBe("你");
  });

  it("rejects malformed SSE data as bad_response", async () => {
    mockFetch(async () =>
      streamResponse(['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', "data: not-json\n\n"]),
    );
    const { deltas, error } = await collectWithError(streamCompletion(cfg, req()));
    expect(deltas).toEqual(["你"]);
    expect(error).toMatchObject({ code: "bad_response", retryable: false });
  });

  it("rejects an error event delivered on HTTP 200 and redacts the key", async () => {
    mockFetch(async () =>
      streamResponse(['data: {"error":{"message":"upstream overloaded for sk-1"}}\n\n']),
    );
    const err = await captureError(collect(streamCompletion(cfg, req())));
    expect(err).toMatchObject({ code: "bad_response", retryable: false });
    expect(err.message).toContain("upstream overloaded");
    expect(err.message).not.toContain("sk-1");
  });

  it("rejects a 200 JSON error body sent to a streaming request", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(collect(streamCompletion(cfg, req()))).rejects.toMatchObject({
      code: "bad_response",
      retryable: false,
    });
  });

  it("keeps a stream alive past the connect budget once headers have arrived", async () => {
    vi.useFakeTimers();
    // Route AbortSignal.timeout through fake timers so a regression that folds
    // the connect deadline into the fetch signal fails deterministically.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(new DOMException("Timeout", "TimeoutError")), ms);
      return abort.signal;
    });

    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    mockFetch(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          // Real fetch errors the response body when its signal aborts.
          init.signal?.addEventListener(
            "abort",
            () => {
              try {
                controller.error(init.signal?.reason);
              } catch {
                // Already closed.
              }
            },
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const deltas: string[] = [];
    const consumed = (async () => {
      for await (const delta of streamCompletion(cfg, req())) deltas.push(delta);
    })();
    const settled = consumed.then(
      () => "done" as const,
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(0); // headers arrive; connect deadline cleared
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUTS.connectMs + 1_000); // still open past 15s
    expect(deltas).toEqual([]);

    const bytes = new TextEncoder();
    try {
      bodyController.enqueue(bytes.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
      bodyController.enqueue(bytes.encode("data: [DONE]\n\n"));
      bodyController.close();
    } catch {
      // A regression would have cancelled the body at the connect budget.
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toBe("done");
    expect(deltas.join("")).toBe("你");
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    mockFetch(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        "data: [DONE]\n\n",
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      ]),
    );
    expect(await collect(streamCompletion(cfg, req()))).toBe("你");
  });

  it("handles CRLF event delimiters", async () => {
    mockFetch(async () =>
      streamResponse(['data: {"choices":[{"delta":{"content":"你"}}]}\r', '\n\r\ndata: [DONE]\r\n\r\n']),
    );
    expect(await collect(streamCompletion(cfg, req()))).toBe("你");
  });

  it("sends stream:true with merged headers", async () => {
    const fn = mockFetch(async () => streamResponse(["data: [DONE]\n\n"]));
    await collect(
      streamCompletion(
        { ...cfg, extraHeaders: { "X-Token": "{{apiKey}}" } },
        req({ model: "m2", messages: [{ role: "user", content: "hi" }] }),
      ),
    );
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/chat/completions");
    expect((init.headers as Record<string, string>)["X-Token"]).toBe("sk-1");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "m2",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      stream: true,
    });
  });

  it("classifies 429 as retryable", async () => {
    mockFetch(async () => new Response("{}", { status: 429 }));
    const gen = streamCompletion(cfg, req());
    await expect(gen.next()).rejects.toMatchObject({ code: "rate_limit", retryable: true });
  });

  it("classifies 500 as a retryable network error", async () => {
    mockFetch(async () => new Response("{}", { status: 500 }));
    await expect(collect(streamCompletion(cfg, req()))).rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("classifies 401 as a non-retryable auth error", async () => {
    mockFetch(async () => new Response("{}", { status: 401 }));
    await expect(collect(streamCompletion(cfg, req()))).rejects.toMatchObject({ code: "auth", retryable: false });
  });

  it("classifies a caller abort as non-retryable", async () => {
    const controller = new AbortController();
    mockFetch(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(collect(streamCompletion(cfg, req({ signal: controller.signal })))).rejects.toMatchObject({
      code: "aborted",
      retryable: false,
    });
  });

  it("classifies a stalled first token as a retryable timeout", async () => {
    vi.useFakeTimers();
    mockFetch(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));

    const pending = streamCompletion(cfg, req()).next();
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUTS.firstTokenMs);

    await assertion;
  });
});

describe("getAdapter", () => {
  it("returns the custom adapter bound to the standalone functions", () => {
    const adapter = getAdapter("custom");
    expect(adapter.id).toBe("custom");
    expect(adapter.listModels).toBe(listModels);
    expect(adapter.complete).toBe(complete);
    expect(adapter.streamCompletion).toBe(streamCompletion);
  });
});
