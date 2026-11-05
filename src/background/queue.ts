/**
 * Global request scheduler for the background service worker.
 *
 * One queue serves both the translate and chat ports: concurrency and RPS are
 * global caps, while ordering is per priority. Chat is served before translate
 * so a question never waits behind a whole page, and translate tasks rotate
 * across tabs so one long page cannot starve another.
 *
 * The queue has no `chrome.*` dependency. It reads no settings: the caller
 * passes the limits it derived (Task 7 owns the defaults) and may update them
 * at runtime with `setLimits`.
 */

export type QueuePriority = "chat" | "translate";

export interface QueueTask<T> {
  tabId: number;
  priority: QueuePriority;
  run(signal: AbortSignal): Promise<T>;
}

export interface RequestQueueOptions {
  /** Maximum tasks running at once, across every tab. Values below 1 clamp to 1. */
  maxConcurrent: number;
  /** Maximum task starts in any rolling second. Values below 1 clamp to 1. */
  maxRPS: number;
  /** Injectable clock in milliseconds; defaults to `Date.now`. */
  now?: () => number;
}

/** Starts are counted over a rolling window, not per calendar second. */
const RATE_WINDOW_MS = 1_000;

/** Fixed message: consumers switch on it, so it is not localized. */
const ABORT_MESSAGE = "aborted";

interface PendingEntry {
  id: number;
  task: QueueTask<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

interface ActiveEntry {
  entry: PendingEntry;
  controller: AbortController;
}

function clampAtLeastOne(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

export class RequestQueue {
  private maxConcurrent: number;
  private maxRPS: number;
  private readonly now: () => number;

  /** Ready-to-run chat tasks, oldest first. */
  private readonly chatQueue: PendingEntry[] = [];

  /** Ready-to-run translate tasks, grouped by tab. */
  private readonly translateByTab = new Map<number, PendingEntry[]>();

  /**
   * Tab ids with pending translate work, in round-robin order. The tab at the
   * front is the one that has waited longest since its last turn.
   */
  private readonly rotation: number[] = [];

  /** Tasks whose `run` has been invoked, keyed by queue id. */
  private readonly active = new Map<number, ActiveEntry>();

  /** Start timestamps inside the rolling window, oldest first. */
  private readonly starts: number[] = [];

  private nextId = 1;
  private pumpQueued = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: RequestQueueOptions) {
    this.maxConcurrent = clampAtLeastOne(opts.maxConcurrent);
    this.maxRPS = clampAtLeastOne(opts.maxRPS);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Running tasks across all tabs. */
  get inflight(): number {
    return this.active.size;
  }

  /** Queued tasks across all tabs and priorities. */
  get pending(): number {
    let total = this.chatQueue.length;
    for (const queue of this.translateByTab.values()) total += queue.length;
    return total;
  }

  /**
   * Replace the global limits. Lowering them never interrupts work that is
   * already running; it only delays the next start.
   */
  setLimits(maxConcurrent: number, maxRPS: number): void {
    this.maxConcurrent = clampAtLeastOne(maxConcurrent);
    this.maxRPS = clampAtLeastOne(maxRPS);
    this.schedulePump();
  }

  /**
   * Queue a task and resolve with its result. If the owning tab is cancelled
   * before or during the run, the promise rejects with `Error("aborted")`.
   */
  enqueue<T>(task: QueueTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: PendingEntry = {
        id: this.nextId++,
        task: task as QueueTask<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (task.priority === "chat") {
        this.chatQueue.push(entry);
      } else {
        const queue = this.translateByTab.get(task.tabId);
        if (queue) {
          queue.push(entry);
        } else {
          this.translateByTab.set(task.tabId, [entry]);
          this.rotation.push(task.tabId);
        }
      }

      // Dispatch from a microtask so a synchronous burst (one page enqueues
      // many groups, a chat request lands mid-page) is ordered as a batch
      // rather than first-come-first-served.
      this.schedulePump();
    });
  }

  /**
   * Abort every running task and reject every queued task for one tab.
   * Other tabs keep running.
   */
  cancelTab(tabId: number): void {
    const abortError = () => new Error(ABORT_MESSAGE);

    const queued = this.translateByTab.get(tabId);
    if (queued) {
      this.translateByTab.delete(tabId);
      const at = this.rotation.indexOf(tabId);
      if (at !== -1) this.rotation.splice(at, 1);
      for (const entry of queued) entry.reject(abortError());
    }

    for (let i = this.chatQueue.length - 1; i >= 0; i--) {
      if (this.chatQueue[i].task.tabId !== tabId) continue;
      const [entry] = this.chatQueue.splice(i, 1);
      entry.reject(abortError());
    }

    // Snapshot: the map is mutated while iterating.
    for (const [id, active] of [...this.active]) {
      if (active.entry.task.tabId !== tabId) continue;
      this.active.delete(id);
      active.controller.abort();
      active.entry.reject(abortError());
    }

    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pump();
    });
  }

  /**
   * Start as much work as the caps allow, then arm exactly one timer if the
   * rate window is the reason we stopped. Concurrency stops are resumed by
   * task completion instead, so no timer is left behind.
   */
  private pump(): void {
    this.pumpQueued = false;
    const now = this.now();
    this.pruneStarts(now);

    for (;;) {
      if (this.pending === 0) {
        this.clearWake();
        return;
      }
      if (this.active.size >= this.maxConcurrent) {
        this.clearWake();
        return;
      }
      if (this.starts.length >= this.maxRPS) {
        const freedAt = this.starts[0] + RATE_WINDOW_MS;
        this.armWake(Math.max(1, freedAt - now));
        return;
      }

      const entry = this.takeNext();
      if (!entry) {
        this.clearWake();
        return;
      }
      this.start(entry, now);
    }
  }

  /** Chat first; then the tab that has waited longest since its last turn. */
  private takeNext(): PendingEntry | undefined {
    const chat = this.chatQueue.shift();
    if (chat) return chat;

    while (this.rotation.length > 0) {
      const tabId = this.rotation[0];
      const queue = this.translateByTab.get(tabId);

      // Defensive: the rotation and the map only diverge if a queue was
      // emptied through a path that forgot to update both.
      if (!queue || queue.length === 0) {
        this.rotation.shift();
        this.translateByTab.delete(tabId);
        continue;
      }

      const entry = queue.shift()!;
      this.rotation.shift();
      if (queue.length > 0) this.rotation.push(tabId);
      else this.translateByTab.delete(tabId);
      return entry;
    }

    return undefined;
  }

  private start(entry: PendingEntry, now: number): void {
    const controller = new AbortController();
    this.active.set(entry.id, { entry, controller });
    this.starts.push(now);

    // Invoke `run` from a microtask so a synchronous throw becomes a
    // rejection and the pump loop is never unwound by a task. A task aborted
    // before this microtask runs is rejected without being started at all.
    Promise.resolve()
      .then(() => (controller.signal.aborted ? undefined : entry.task.run(controller.signal)))
      .then(
        value => this.finish(entry, () => entry.resolve(value)),
        reason => this.finish(entry, () => entry.reject(reason)),
      );
  }

  private finish(entry: PendingEntry, settle: () => void): void {
    // A cancelled task already rejected its caller and freed its slot.
    if (!this.active.delete(entry.id)) return;
    settle();
    this.schedulePump();
  }

  private pruneStarts(now: number): void {
    let expired = 0;
    while (expired < this.starts.length && now - this.starts[expired] >= RATE_WINDOW_MS) {
      expired++;
    }
    if (expired > 0) this.starts.splice(0, expired);
  }

  private armWake(delayMs: number): void {
    this.clearWake();
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, delayMs);
  }

  private clearWake(): void {
    if (this.wakeTimer === undefined) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }
}
