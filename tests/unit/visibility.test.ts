import { it, expect, vi, afterEach } from "vitest";
import { createVisibilityObserver, inPrefetchBand } from "../../src/content/visibility";

type Entry = { target: Element; isIntersecting: boolean };

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(
    public readonly callback: IntersectionObserverCallback,
    public readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.targets.add(el);
  }

  unobserve(el: Element): void {
    this.targets.delete(el);
  }

  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(entries: Entry[]): void {
    this.callback(
      entries.map((entry) => ({
        ...entry,
        intersectionRatio: entry.isIntersecting ? 1 : 0,
      })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

function installFake(): void {
  FakeIntersectionObserver.instances = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
}

afterEach(() => {
  vi.useRealTimers();
});

it("treats the viewport plus the prefetch band as visible", () => {
  expect(inPrefetchBand({ top: 100, bottom: 140 }, 800, 1)).toBe(true);
  expect(inPrefetchBand({ top: -20, bottom: 60 }, 800, 1)).toBe(true);
  expect(inPrefetchBand({ top: 850, bottom: 900 }, 800, 1)).toBe(true);
  expect(inPrefetchBand({ top: 1700, bottom: 1760 }, 800, 1)).toBe(false);
  expect(inPrefetchBand({ top: -120, bottom: -60 }, 800, 1)).toBe(false);
});

it("batches intersecting roots once after the window and stops observing them", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  expect(io.options.rootMargin).toBe("0px 0px 100% 0px");

  const root = document.createElement("p");
  gate.observe(root, ["a", "b"]);
  expect(io.targets.has(root)).toBe(true);

  io.fire([{ target: root, isIntersecting: true }]);
  vi.advanceTimersByTime(149);
  expect(batches).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(batches).toEqual([["a", "b"]]);
  expect(io.targets.has(root)).toBe(false);

  io.fire([{ target: root, isIntersecting: true }]);
  vi.advanceTimersByTime(150);
  expect(batches).toHaveLength(1);
});

it("coalesces two roots that intersect in the same window", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const first = document.createElement("p");
  const second = document.createElement("p");
  gate.observe(first, ["a"]);
  gate.observe(second, ["b"]);

  io.fire([
    { target: first, isIntersecting: true },
    { target: second, isIntersecting: true },
  ]);
  vi.advanceTimersByTime(150);

  expect(batches).toHaveLength(1);
  expect([...batches[0]].sort()).toEqual(["a", "b"]);
});

it("ignores entries that are not intersecting", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const root = document.createElement("p");
  gate.observe(root, ["a"]);

  io.fire([{ target: root, isIntersecting: false }]);
  vi.advanceTimersByTime(150);

  expect(batches).toEqual([]);
  expect(io.targets.has(root)).toBe(true);
});

it("drops pending work and disconnects on stop", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const root = document.createElement("p");
  gate.observe(root, ["a"]);
  io.fire([{ target: root, isIntersecting: true }]);

  gate.stop();
  vi.advanceTimersByTime(150);

  expect(batches).toEqual([]);
  expect(io.disconnected).toBe(true);
  expect(io.targets.size).toBe(0);
});

it("stops mapping a root after unobserve", () => {
  vi.useFakeTimers();
  installFake();
  const batches: string[][] = [];
  const gate = createVisibilityObserver({
    prefetchScreens: 1,
    batchMs: 150,
    onVisible: (ids) => batches.push(ids),
  });
  const io = FakeIntersectionObserver.instances[0];
  const root = document.createElement("p");
  gate.observe(root, ["a"]);
  gate.unobserve(root);

  io.fire([{ target: root, isIntersecting: true }]);
  vi.advanceTimersByTime(150);

  expect(batches).toEqual([]);
});
