/**
 * jsdom has no IntersectionObserver. Most content-script tests rely on the
 * eager viewport band (jsdom reports every rect at the origin); this no-op
 * class keeps activation from throwing. Tests that assert lazy behavior
 * install a recording fake in place of this class.
 */
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds: ReadonlyArray<number> = [];

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

if (typeof globalThis.IntersectionObserver !== "function") {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    NoopIntersectionObserver;
}
