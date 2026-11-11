/**
 * Minimal OpenAI-compatible mock provider plus a static fixture host for the
 * Playwright suite. One ephemeral loopback port serves both so the extension
 * can fetch completions and load the fixture page from the same origin.
 *
 * Every request is recorded (method, URL, parsed body) so tests can assert that
 * an already-Chinese page sends nothing at all.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface MockServer {
  /** Ephemeral loopback port. */
  port: number;
  /** `http://127.0.0.1:<port>` without a trailing slash. */
  origin: string;
  /** Every request handled so far, in arrival order. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface MockGlossaryNote {
  surface: string;
  pos?: string;
  meaning: string;
  example?: string;
}

export interface MockServerOptions {
  /** Translated text for segment `index`; the `[index] ` prefix is added. */
  reply?: (index: number, sourceText: string) => string;
  /** Optional glossary notes for segment `index`. */
  glossary?: (index: number, sourceText: string) => MockGlossaryNote[] | undefined;
  /** Emit the glossary block between numbered lines, as some models do. */
  splitGlossary?: boolean;
  /** Directory containing the HTML fixtures (defaults to `tests/fixtures`). */
  fixtureDir?: string;
}

const DEFAULT_FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function corsPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "600",
  });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Extract `[n] text` lines from the user message and number the reply. */
function buildTranslationReply(
  body: unknown,
  reply: NonNullable<MockServerOptions["reply"]>,
  glossary?: NonNullable<MockServerOptions["glossary"]>,
  splitGlossary = false,
): string {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return "[1] 译文";

  const user = [...messages]
    .reverse()
    .find((message) => (message as { role?: unknown })?.role === "user") as
    | { content?: unknown }
    | undefined;
  const content = typeof user?.content === "string" ? user.content : "";

  const lines: string[] = [];
  const notes: Record<string, MockGlossaryNote[]> = {};
  for (const line of content.split("\n")) {
    const match = /^\[(\d+)\]\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const index = Number(match[1]);
    const sourceText = match[2];
    lines.push(`[${index}] ${reply(index, sourceText)}`);
    const segmentNotes = glossary?.(index, sourceText);
    if (segmentNotes && segmentNotes.length > 0) notes[String(index)] = segmentNotes;
  }

  if (lines.length === 0) return "[1] 译文";
  if (Object.keys(notes).length === 0) return lines.join("\n");
  const block = `<<<ILMT_GLOSSARY>>>\n${JSON.stringify(notes)}`;
  if (splitGlossary && lines.length > 1) {
    return `${lines[0]}\n${block}\n${lines.slice(1).join("\n")}`;
  }
  return `${lines.join("\n")}\n${block}`;
}

function sse(res: ServerResponse, text: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const chunks = text.split("\n").map((line) => `${line}\n`);
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function serveFixture(res: ServerResponse, pathname: string, fixtureDir: string): Promise<void> {
  // Basename-only mapping keeps the fixture host from reading outside its dir.
  const name = basename(pathname);
  if (!name.endsWith(".html")) {
    json(res, 404, { error: "not found" });
    return;
  }

  try {
    const html = await readFile(resolve(fixtureDir, name), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(html);
  } catch {
    json(res, 404, { error: "unknown fixture" });
  }
}

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  const reply = options.reply ?? (() => "译文");
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      const pathname = url.split("?", 1)[0] ?? "/";

      if (method === "OPTIONS") {
        corsPreflight(res);
        return;
      }

      if (method === "GET" && pathname === "/v1/models") {
        requests.push({ method, url, body: undefined });
        json(res, 200, {
          object: "list",
          data: [
            { id: "mock-model", object: "model", owned_by: "e2e" },
            { id: "mock-model-2", object: "model", owned_by: "e2e" },
          ],
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/chat/completions") {
        const body = await readBody(req);
        requests.push({ method, url, body });
        const text = buildTranslationReply(
          body,
          reply,
          options.glossary,
          options.splitGlossary,
        );

        if ((body as { stream?: unknown })?.stream === true) {
          sse(res, text);
        } else {
          json(res, 200, {
            id: "chatcmpl-e2e",
            object: "chat.completion",
            model: (body as { model?: unknown })?.model ?? "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        }
        return;
      }

      if (method === "GET") {
        await serveFixture(res, pathname, fixtureDir);
        return;
      }

      json(res, 404, { error: "not found" });
    })().catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("mock server did not bind a TCP port");
  }

  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}
