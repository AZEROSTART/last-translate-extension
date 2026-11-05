import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTranslatePort } from "../../src/content/port";
import type { TranslatePort } from "../../src/content/port";

function fakePort(): TranslatePort {
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
  };
}

/** A fake port that captures the registered listeners so tests can drive server messages. */
function capturePort() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: TranslatePort = {
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn((cb) => messageListeners.push(cb)) },
    onDisconnect: { addListener: vi.fn((cb) => disconnectListeners.push(cb)) },
    disconnect: vi.fn(),
  };
  return { port, messageListeners, disconnectListeners };
}

function callbacks() {
  return { onDelta: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };
}

beforeEach(() => { vi.useFakeTimers(); });

describe("createTranslatePort", () => {
  it("reconnects with the documented backoff and retries once", async () => {
    const connect = vi.fn()
      .mockImplementationOnce(() => { throw new Error("Extension context invalidated"); })
      .mockImplementation(() => fakePort());
    const p = createTranslatePort({ connect, ...callbacks() });
    p.send({ type: "ping" });
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("resends the pending message once the port reconnects", async () => {
    const port = fakePort();
    const connect = vi.fn()
      .mockImplementationOnce(() => { throw new Error("Extension context invalidated"); })
      .mockImplementation(() => port);
    const p = createTranslatePort({ connect, ...callbacks() });
    p.send({ type: "ping" });
    await vi.advanceTimersByTimeAsync(500);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "ping" });
    expect(p.state).toBe("healthy");
  });

  it("degrades after exhausting the backoff and reports the connection failure", async () => {
    const connect = vi.fn(() => { throw new Error("Extension context invalidated"); });
    const cb = callbacks();
    const p = createTranslatePort({ connect, ...cb });
    p.send({ type: "ping" });
    expect(p.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000 + 5000);
    expect(p.state).toBe("degraded");
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ type: "connection-error" }));
    expect(connect).toHaveBeenCalledTimes(6);
  });

  it("stops reconnecting after close()", async () => {
    const connect = vi.fn(() => { throw new Error("Extension context invalidated"); });
    const p = createTranslatePort({ connect, ...callbacks() });
    p.send({ type: "ping" });
    p.close();
    await vi.advanceTimersByTimeAsync(20000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("recovers on a later send after entering degraded", async () => {
    const connect = vi.fn<() => TranslatePort>(() => { throw new Error("Extension context invalidated"); });
    const p = createTranslatePort({ connect, ...callbacks() });
    p.send({ type: "ping" });
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000 + 5000);
    expect(p.state).toBe("degraded");
    connect.mockImplementation(() => fakePort());
    p.send({ type: "ping" });
    expect(p.state).toBe("healthy");
  });

  it("routes incoming messages and ignores unknown ones", () => {
    const { port, messageListeners } = capturePort();
    const cb = callbacks();
    const p = createTranslatePort({ connect: () => port, ...cb });
    p.send({ type: "ping" });

    const delta = { type: "delta", requestId: "r1", id: "p_1", text: "你" } as const;
    messageListeners[0](delta);
    expect(cb.onDelta).toHaveBeenCalledWith(delta);

    const result = { type: "result", requestId: "r1", items: [{ id: "p_1", text: "你" }] } as const;
    messageListeners[0](result);
    expect(cb.onResult).toHaveBeenCalledWith(result);

    const error = { type: "error", requestId: "r1", code: "rate_limit", message: "slow down", retryable: true, ids: ["p_1"] } as const;
    messageListeners[0](error);
    expect(cb.onError).toHaveBeenCalledWith(error);

    const finish = { type: "finish", requestId: "r1" } as const;
    messageListeners[0](finish);
    expect(cb.onFinish).toHaveBeenCalledWith(finish);

    // pong, page-navigated and unknown types are ignored (no handler).
    messageListeners[0]({ type: "pong" });
    messageListeners[0]({ type: "page-navigated" });
    messageListeners[0]({ type: "bogus" });
    messageListeners[0](null);
    expect(cb.onDelta).toHaveBeenCalledTimes(1);
    expect(cb.onResult).toHaveBeenCalledTimes(1);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onFinish).toHaveBeenCalledTimes(1);
  });
});
