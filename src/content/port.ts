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

  /**
   * Mark the current connection as healthy: reset the backoff and cancel any
   * armed reconnect. A connection proven by a successful post (or a fresh
   * `connect`) supersedes a pending reconnect, so its timer must never open a
   * second, orphaned port.
   */
  function markHealthy(): void {
    state = "healthy";
    backoffIndex = 0;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
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
    markHealthy();
    return true;
  }

  /**
   * Post every queued message to the current port, preserving order. On a
   * failed post the failed message and the not-yet-sent remainder are requeued
   * and false is returned; the caller owns the port/backoff transition.
   */
  function flushPending(): boolean {
    const messages = pending;
    pending = [];
    for (let i = 0; i < messages.length; i++) {
      if (!postToPort(port!, messages[i])) {
        pending.push(...messages.slice(i));
        return false;
      }
    }
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
    // Supersession guard: only the reconnecting state owns the backoff timer.
    // A successful send() clears the timer and marks the connection healthy,
    // but a timer that raced the clearTimeout may still fire; it must not open
    // a second port.
    if (state !== "reconnecting") return;
    if (!establish()) {
      scheduleReconnect();
      return;
    }
    if (!flushPending()) {
      // The fresh port rejected the queued messages; drop it and back off.
      port = null;
      state = "reconnecting";
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
    if (!port && !establish()) {
      fail(message);
      return;
    }
    // The current connection (freshly established or already live) owns the
    // queued messages: flush them before the new one. A fresh establish
    // cancels the armed reconnect, so without this flush a message queued by a
    // failed send would be stranded with no timer left to deliver it.
    if (!flushPending()) {
      port = null;
      fail(message);
      return;
    }
    if (!postToPort(port!, message)) {
      port = null;
      fail(message);
      return;
    }
    markHealthy();
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
