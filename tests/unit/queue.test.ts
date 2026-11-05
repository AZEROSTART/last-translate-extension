import { it, expect, vi } from "vitest";
import { RequestQueue } from "../../src/background/queue";

const tick = () => new Promise(r => setTimeout(r, 0));

it("never exceeds maxConcurrent", async () => {
  const q = new RequestQueue({ maxConcurrent: 2, maxRPS: 100 });
  let peak = 0, live = 0;
  const job = () => q.enqueue({ tabId: 1, priority: "translate", run: async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 10)); live--; } });
  await Promise.all(Array.from({ length: 6 }, job));
  expect(peak).toBe(2);
});

it("enforces the RPS window", async () => {
  vi.useFakeTimers();
  try {
    const q = new RequestQueue({ maxConcurrent: 10, maxRPS: 2 });
    let started = 0;
    const tasks = Array.from({ length: 4 }, () => q.enqueue({ tabId: 1, priority: "translate", run: async () => { started++; } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(2);
    // A start stays counted for the full rolling second, so a 2-RPS limit can
    // only release the second pair once the first pair leaves the window.
    await vi.advanceTimersByTimeAsync(500);
    expect(started).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(started).toBe(4);
    await Promise.all(tasks);
  } finally {
    vi.useRealTimers();
  }
});

it("round-robins between tabs", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  const order: number[] = [];
  await Promise.all([
    q.enqueue({ tabId: 1, priority: "translate", run: async () => { order.push(1); } }),
    q.enqueue({ tabId: 1, priority: "translate", run: async () => { order.push(1); } }),
    q.enqueue({ tabId: 2, priority: "translate", run: async () => { order.push(2); } }),
    q.enqueue({ tabId: 2, priority: "translate", run: async () => { order.push(2); } }),
  ]);
  expect(order.slice(0, 2).sort()).toEqual([1, 2]);
  expect(order).toEqual([1, 2, 1, 2]);
});

it("chat runs before translate", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  const order: string[] = [];
  await Promise.all([
    q.enqueue({ tabId: 1, priority: "translate", run: async () => { order.push("t"); } }),
    q.enqueue({ tabId: 1, priority: "chat", run: async () => { order.push("c"); } }),
  ]);
  expect(order[0]).toBe("c");
});

it("cancelTab rejects pending and aborts inflight", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  let aborted = false;
  const inflight = q.enqueue({ tabId: 7, priority: "translate", run: s => new Promise((_, rej) => { s.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }); }) });
  const pending = q.enqueue({ tabId: 7, priority: "translate", run: async () => {} });
  // Dispatch is coalesced into a microtask; wait for the first task to start.
  await tick();
  q.cancelTab(7);
  await expect(pending).rejects.toThrow("aborted");
  await expect(inflight).rejects.toThrow("aborted");
  expect(aborted).toBe(true);
});

it("cancelling one tab leaves other tabs running", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  const ran: number[] = [];
  const blocked = q.enqueue({ tabId: 1, priority: "translate", run: () => new Promise<void>(() => {}) });
  const other = q.enqueue({ tabId: 2, priority: "translate", run: async () => { ran.push(2); } });

  await tick();
  expect(q.inflight).toBe(1);

  // A chat task queued for the doomed tab must be rejected too.
  const chat = q.enqueue({ tabId: 1, priority: "chat", run: async () => { ran.push(1); } });
  q.cancelTab(1);

  await expect(chat).rejects.toThrow("aborted");
  await expect(blocked).rejects.toThrow("aborted");
  await expect(other).resolves.toBeUndefined();
  expect(ran).toEqual([2]);
});

it("does not start a task cancelled before its first tick", async () => {
  const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
  let ran = false;
  const task = q.enqueue({ tabId: 3, priority: "translate", run: async () => { ran = true; } });

  // Dispatch runs in a microtask; this continuation is queued after it but
  // before the task's own `run` microtask.
  await Promise.resolve();
  q.cancelTab(3);

  await expect(task).rejects.toThrow("aborted");
  expect(ran).toBe(false);
});

it("leaves no timers behind once a rate-limited batch drains", async () => {
  vi.useFakeTimers();
  try {
    const q = new RequestQueue({ maxConcurrent: 10, maxRPS: 1 });
    let started = 0;
    const tasks = Array.from({ length: 3 }, () => q.enqueue({ tabId: 1, priority: "translate", run: async () => { started++; } }));

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(started).toBe(3);
    await Promise.all(tasks);

    expect(vi.getTimerCount()).toBe(0);
    expect(q.inflight).toBe(0);
    expect(q.pending).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("setLimits takes effect without interrupting running work", async () => {
  vi.useFakeTimers();
  try {
    const q = new RequestQueue({ maxConcurrent: 1, maxRPS: 100 });
    let started = 0;
    const tasks = Array.from({ length: 4 }, () => q.enqueue({ tabId: 1, priority: "translate", run: async () => { started++; await new Promise(r => setTimeout(r, 1_000)); } }));

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(1);

    q.setLimits(4, 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(4);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(tasks);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
