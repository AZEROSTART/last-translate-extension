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
    // Mimic Chrome: disconnect() fires the registered onDisconnect listeners.
    disconnect: vi.fn(() => {
      for (const cb of disconnectListeners) cb();
    }),
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

describe("createTranslatePort disconnect signaling", () => {
  it("consumes runtime.lastError when the page's port disconnects into bfcache", () => {
    const runtime = (globalThis as any).chrome.runtime;
    let reads = 0;
    const original = Object.getOwnPropertyDescriptor(runtime, "lastError");
    Object.defineProperty(runtime, "lastError", {
      configurable: true,
      get() {
        reads += 1;
        return { message: "The page keeping the extension port is moved into back/forward cache" };
      },
    });

    try {
      const { port, disconnectListeners } = capturePort();
      const p = createTranslatePort({ connect: () => port, ...callbacks() });
      p.send({ type: "ping" });

      disconnectListeners[0]();

      expect(reads).toBeGreaterThan(0);
      p.close();
    } finally {
      if (original) Object.defineProperty(runtime, "lastError", original);
      else delete runtime.lastError;
    }
  });

  it("fires onDisconnect exactly once per server disconnect and enters reconnecting", () => {
    const { port, disconnectListeners } = capturePort();
    const onDisconnect = vi.fn();
    const p = createTranslatePort({ connect: () => port, onDisconnect, ...callbacks() });
    p.send({ type: "ping" });
    expect(p.state).toBe("healthy");

    disconnectListeners[0]();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(p.state).toBe("reconnecting");
  });

  it("reconnects via backoff after a server disconnect without re-firing onDisconnect", async () => {
    const first = capturePort();
    const second = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockReturnValueOnce(first.port)
      .mockReturnValue(second.port);
    const onDisconnect = vi.fn();
    const p = createTranslatePort({ connect, onDisconnect, ...callbacks() });
    p.send({ type: "ping" });

    first.disconnectListeners[0]();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(p.state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.disconnectListeners).toHaveLength(1);
    expect(p.state).toBe("healthy");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDisconnect for a caller-initiated close()", () => {
    const { port } = capturePort();
    const onDisconnect = vi.fn();
    const p = createTranslatePort({ connect: () => port, onDisconnect, ...callbacks() });
    p.send({ type: "ping" });

    p.close();

    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("fires onError once and degrades when retries are exhausted after a disconnect", async () => {
    const first = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockReturnValueOnce(first.port)
      .mockImplementation(() => {
        throw new Error("Extension context invalidated");
      });
    const cb = { ...callbacks(), onDisconnect: vi.fn() };
    const p = createTranslatePort({ connect, ...cb });
    p.send({ type: "ping" });

    first.disconnectListeners[0]();
    expect(p.state).toBe("reconnecting");
    expect(cb.onDisconnect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000 + 5000);

    expect(p.state).toBe("degraded");
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ type: "connection-error" }));
    // The disconnect is signaled once, not once per backoff step.
    expect(cb.onDisconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(6);
  });
});

describe("createTranslatePort send during reconnecting", () => {
  it("cancels the armed reconnect timer so a successful send leaves one connection", async () => {
    const first = capturePort();
    const second = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockReturnValueOnce(first.port)
      .mockReturnValue(second.port);
    const onDisconnect = vi.fn();
    const p = createTranslatePort({ connect, onDisconnect, ...callbacks() });
    p.send({ type: "ping" });

    first.disconnectListeners[0]();
    expect(p.state).toBe("reconnecting");
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // A new paragraph arrives during the backoff window; the connection succeeds.
    p.send({ type: "ping" });
    expect(p.state).toBe("healthy");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.port.postMessage).toHaveBeenCalledTimes(1);

    // The armed timer must not run reconnect() and open an orphaned connection.
    await vi.advanceTimersByTimeAsync(20000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.port.postMessage).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("flushes a message queued by a failed send when a later send establishes the port", async () => {
    // The first connection is established but its postMessage throws, so `ping`
    // lands in `pending` and a reconnect timer is armed.
    const failing = capturePort();
    failing.port.postMessage = vi.fn(() => {
      throw new Error("Extension context invalidated");
    });
    const recovered = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockReturnValueOnce(failing.port)
      .mockReturnValue(recovered.port);
    const p = createTranslatePort({ connect, ...callbacks() });

    p.send({ type: "ping" });
    expect(p.state).toBe("reconnecting");

    // A second send before the timer fires establishes the port successfully.
    // The queued `ping` must be flushed on the new port before the new message.
    p.send({ type: "abort", requestId: "r2" });
    expect(p.state).toBe("healthy");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recovered.port.postMessage).toHaveBeenCalledTimes(2);
    expect(recovered.port.postMessage).toHaveBeenNthCalledWith(1, { type: "ping" });
    expect(recovered.port.postMessage).toHaveBeenNthCalledWith(2, { type: "abort", requestId: "r2" });

    // The cancelled timer must not deliver either message a second time or
    // open a third connection.
    await vi.advanceTimersByTimeAsync(20000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recovered.port.postMessage).toHaveBeenCalledTimes(2);
  });

  it("flushes a message queued by a first connect failure when a later send succeeds", async () => {
    // The simpler trigger from the finding: connect throws, then a second send
    // succeeds while the reconnect timer is armed.
    const recovered = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockImplementationOnce(() => {
        throw new Error("Extension context invalidated");
      })
      .mockReturnValue(recovered.port);
    const p = createTranslatePort({ connect, ...callbacks() });

    p.send({ type: "ping" });
    expect(p.state).toBe("reconnecting");

    p.send({ type: "abort", requestId: "r2" });
    expect(p.state).toBe("healthy");
    expect(recovered.port.postMessage).toHaveBeenCalledTimes(2);
    expect(recovered.port.postMessage).toHaveBeenNthCalledWith(1, { type: "ping" });
    expect(recovered.port.postMessage).toHaveBeenNthCalledWith(2, { type: "abort", requestId: "r2" });

    await vi.advanceTimersByTimeAsync(20000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recovered.port.postMessage).toHaveBeenCalledTimes(2);
  });

  it("treats a stale reconnect invocation after a successful send as a no-op", async () => {
    const first = capturePort();
    const second = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockReturnValueOnce(first.port)
      .mockReturnValue(second.port);

    // Capture the scheduled reconnect callback so the test can fire it even
    // though establish() has already cancelled the timer (a real timer race).
    const scheduled: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
      scheduled.push(handler);
      return originalSetTimeout(handler, timeout);
    }) as unknown as typeof setTimeout;
    try {
      const p = createTranslatePort({ connect, ...callbacks() });
      p.send({ type: "ping" });
      first.disconnectListeners[0]();
      expect(p.state).toBe("reconnecting");
      expect(scheduled).toHaveLength(1);

      // A send establishes connection #2 and cancels the backoff.
      p.send({ type: "ping" });
      expect(p.state).toBe("healthy");
      expect(connect).toHaveBeenCalledTimes(2);

      // The stale callback must not open a third port.
      scheduled[0]();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.port.postMessage).toHaveBeenCalledTimes(1);
      expect(p.state).toBe("healthy");

      await vi.advanceTimersByTimeAsync(20000);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("does not strand a mid-batch resend failure behind a healthy send", async () => {
    // connect #1/#2 throw, so two messages are queued. Reconnect #3 opens a
    // port that rejects the queued `ping`, leaving a mid-batch failure.
    const partial = capturePort();
    partial.port.postMessage = vi.fn((message: unknown) => {
      if ((message as { type: string }).type === "ping") {
        throw new Error("Extension context invalidated");
      }
    });
    const recovered = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockImplementationOnce(() => {
        throw new Error("Extension context invalidated");
      })
      .mockImplementationOnce(() => {
        throw new Error("Extension context invalidated");
      })
      .mockReturnValueOnce(partial.port)
      .mockReturnValue(recovered.port);
    const p = createTranslatePort({ connect, ...callbacks() });

    p.send({ type: "ping" });
    p.send({ type: "abort", requestId: "r1" });
    await vi.advanceTimersByTimeAsync(500);
    expect(p.state).toBe("reconnecting");

    // A send succeeds immediately on a fresh connection; the queued messages
    // must go there too, not stay behind on the half-failed port.
    p.send({ type: "abort", requestId: "r2" });
    expect(p.state).toBe("healthy");
    expect(recovered.port.postMessage).toHaveBeenCalledTimes(3);
    expect(recovered.port.postMessage).toHaveBeenNthCalledWith(1, { type: "ping" });
    expect(recovered.port.postMessage).toHaveBeenNthCalledWith(2, { type: "abort", requestId: "r1" });
    expect(recovered.port.postMessage).toHaveBeenNthCalledWith(3, { type: "abort", requestId: "r2" });

    await vi.advanceTimersByTimeAsync(20000);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(recovered.port.postMessage).toHaveBeenCalledTimes(3);
  });

  it("still signals and recovers from a genuine disconnect after a send-recovery", async () => {
    const first = capturePort();
    const second = capturePort();
    const third = capturePort();
    const connect = vi.fn<() => TranslatePort>()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(second.port)
      .mockReturnValue(third.port);
    const onDisconnect = vi.fn();
    const p = createTranslatePort({ connect, onDisconnect, ...callbacks() });
    p.send({ type: "ping" });

    // Recover from the first server disconnect via a send during the backoff.
    first.disconnectListeners[0]();
    p.send({ type: "ping" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(p.state).toBe("healthy");

    // A later, genuine server disconnect is still signaled exactly once…
    second.disconnectListeners[0]();
    expect(onDisconnect).toHaveBeenCalledTimes(2);
    expect(p.state).toBe("reconnecting");

    // …and the normal backoff reconnect still works.
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(p.state).toBe("healthy");
  });
});
