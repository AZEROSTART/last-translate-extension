/**
 * Resilient translate-port client for the content script.
 *
 * Owns the `ilmt-translate` connection lifecycle and the reconnect policy from
 * spec §8.11. It is deliberately free of DOM and registry coupling: it exposes
 * the connection state, fires `onDisconnect` once per server-initiated
 * disconnect (so the caller, which owns the paragraph registry, can requeue
 * inflight paragraphs per spec §8.4), and fires `onError` on the terminal
 * `degraded` state.
 *
 * Reconnect policy: a `send` that fails (port missing / "Extension context
 * invalidated") moves the client into `reconnecting`, retries `connect` on the
 * documented backoff `[500, 1000, 2000, 4000, 5000]`, resends the pending
 * message once the port is back, and reports a `connection-error` through
 * `onError` once the backoff is exhausted (state `degraded`). `close()` clears
 * any pending timer so nothing fires after teardown.
 */

import type { BackgroundToClient, ClientToBackground } from "../shared/types";

/** The minimal port surface this client touches; injected in tests, defaulted to `chrome.runtime`. */
export interface TranslatePort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  disconnect(): void;
}

/** A background-reported request error, routed straight to `onError`. */
export type BackgroundError = Extract<BackgroundToClient, { type: "error" }>;

/** A transport failure; the caller should requeue inflight paragraphs. */
export interface ConnectionError {
  type: "connection-error";
  message: string;
}

export type PortError = BackgroundError | ConnectionError;

export type PortState = "healthy" | "reconnecting" | "degraded";

export interface TranslatePortCallbacks {
  onDelta(message: Extract<BackgroundToClient, { type: "delta" }>): void;
  onResult(message: Extract<BackgroundToClient, { type: "result" }>): void;
  onError(message: PortError): void;
  onFinish(message: Extract<BackgroundToClient, { type: "finish" }>): void;
}

export interface CreateTranslatePortOptions extends TranslatePortCallbacks {
  /** Test seam: overrides `chrome.runtime.connect`. */
  connect?: (name: string) => TranslatePort;
  /**
   * Fired synchronously exactly once per server-initiated disconnect, before
   * the reconnect backoff starts. The caller should requeue inflight
   * paragraphs here (spec §8.4). Not fired for a caller-initiated `close()`.
   */
  onDisconnect?: () => void;
}

export interface TranslatePortClient {
  send(message: ClientToBackground): void;
  close(): void;
  readonly state: PortState;
}

const PORT_NAME = "ilmt-translate";
const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];

const DEFAULT_CONNECT = (name: string): TranslatePort =>
  chrome.runtime.connect({ name }) as unknown as TranslatePort;

export function createTranslatePort(options: CreateTranslatePortOptions): TranslatePortClient {
  const connect = options.connect ?? DEFAULT_CONNECT;

  let port: TranslatePort | null = null;
  let state: PortState = "healthy";
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffIndex = 0;
  let pending: ClientToBackground[] = [];

  function route(raw: unknown): void {
    if (raw === null || typeof raw !== "object") return;
    const message = raw as BackgroundToClient;
    switch (message.type) {
      case "delta":
        options.onDelta(message);
        break;
      case "result":
        options.onResult(message);
        break;
      case "error":
        options.onError(message);
        break;
      case "finish":
        options.onFinish(message);
        break;
      // pong, page-navigated, and unknown messages have no handler here.
      default:
        break;
    }
  }

  /** Establish a fresh connection; on failure leaves `port` null and returns false. */
  function establish(): boolean {
    if (closed) return false;
    let next: TranslatePort | null = null;
    try {
      next = connect(PORT_NAME);
    } catch {
      next = null;
    }
    if (!next) {
      port = null;
      return false;
    }
    port = next;
    next.onMessage.addListener(route);
    next.onDisconnect.addListener(handleDisconnect);
    state = "healthy";
    return true;
  }

  function postToPort(target: TranslatePort, message: ClientToBackground): boolean {
    try {
      target.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  function degrade(): void {
    if (closed || state === "degraded") return;
    state = "degraded";
    pending = [];
    reconnectTimer = null;
    options.onError({
      type: "connection-error",
      message: "translate port reconnection exhausted",
    } satisfies ConnectionError);
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    if (backoffIndex >= BACKOFF_MS.length) {
      degrade();
      return;
    }
    const delay = BACKOFF_MS[backoffIndex++];
    reconnectTimer = setTimeout(reconnect, delay);
  }

  function reconnect(): void {
    reconnectTimer = null;
    if (closed) return;
    if (establish()) {
      backoffIndex = 0;
      const messages = pending;
      pending = [];
      for (let i = 0; i < messages.length; i++) {
        if (!postToPort(port!, messages[i])) {
          // Requeue the failed message and any not-yet-sent remainder.
          pending.push(...messages.slice(i));
          state = "reconnecting";
          scheduleReconnect();
          return;
        }
      }
    } else {
      scheduleReconnect();
    }
  }

  function fail(message?: ClientToBackground): void {
    if (closed) return;
    if (message) pending.push(message);
    state = "reconnecting";
    scheduleReconnect();
  }

  function handleDisconnect(): void {
    // `closed` is set before `port.disconnect()` in close(), so a
    // caller-initiated close never reaches onDisconnect.
    if (closed) return;
    port = null;
    if (state === "degraded") return;
    state = "reconnecting";
    options.onDisconnect?.();
    scheduleReconnect();
  }

  function send(message: ClientToBackground): void {
    if (closed) return;
    // A send after a degraded episode starts a fresh reconnect cycle.
    if (state === "degraded") backoffIndex = 0;
    if (!port) {
      if (!establish()) {
        fail(message);
        return;
      }
    }
    if (!postToPort(port!, message)) {
      port = null;
      fail(message);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    pending = [];
    if (port) {
      try {
        port.disconnect();
      } catch {
        // The port may already be gone during shutdown.
      }
      port = null;
    }
  }

  return {
    send,
    close,
    get state(): PortState {
      return state;
    },
  };
}
