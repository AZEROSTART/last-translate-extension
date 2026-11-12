/**
 * Viewport visibility gate for lazy translation.
 *
 * The scanner marks the whole page, but a paragraph may only be queued for
 * translation once its piece root is inside the viewport band. This module
 * owns that decision for everything that enters the band after the initial
 * scan; `main.ts` keeps the synchronous first pass and the translation
 * scheduling. It never touches the DOM or the registry.
 */

export interface VisibilityOptions {
  /** Extra viewport heights below the fold that count as visible. */
  prefetchScreens: number;
  /** Coalescing window for roots that enter the band together. */
  batchMs: number;
  /** Called once per window with the ids that just became visible. */
  onVisible(ids: string[]): void;
}

export interface VisibilityObserver {
  /** Observe a piece root; its ids are reported when it enters the band. */
  observe(root: Element, ids: string[]): void;
  /** Stop observing a root whose paragraphs were invalidated. */
  unobserve(root: Element): void;
  /** Disconnect and drop any pending batch (restore / rescan). */
  stop(): void;
}

/**
 * A root counts as visible when it intersects the viewport or the prefetch
 * band below it. `prefetchScreens = 0` means strictly the viewport.
 */
export function inPrefetchBand(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  prefetchScreens: number,
): boolean {
  return rect.bottom >= 0 && rect.top <= viewportHeight * (1 + prefetchScreens);
}

export function createVisibilityObserver(options: VisibilityOptions): VisibilityObserver {
  const roots = new Map<Element, Set<string>>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    const ids = [...pending];
    pending.clear();
    if (ids.length > 0) options.onVisible(ids);
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(flush, options.batchMs);
  }

  const io = new IntersectionObserver(
    (entries) => {
      let found = false;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const ids = roots.get(entry.target);
        if (!ids) continue;
        // One root fires once: keep the callback idempotent if a browser
        // delivers a second entry for an element we already released.
        io.unobserve(entry.target);
        roots.delete(entry.target);
        for (const id of ids) pending.add(id);
        found = true;
      }
      if (found) schedule();
    },
    {
      root: null,
      rootMargin: `0px 0px ${options.prefetchScreens * 100}% 0px`,
      threshold: 0,
    },
  );

  return {
    observe(root, ids) {
      const existing = roots.get(root);
      if (existing) {
        for (const id of ids) existing.add(id);
        return;
      }
      roots.set(root, new Set(ids));
      io.observe(root);
    },
    unobserve(root) {
      if (!roots.delete(root)) return;
      io.unobserve(root);
    },
    stop() {
      io.disconnect();
      roots.clear();
      pending.clear();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
