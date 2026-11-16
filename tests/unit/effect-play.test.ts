import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catHoardEffect } from "../../src/content/effects/cat-hoard";
import { catStickerEffect } from "../../src/content/effects/cat-sticker";
import { gopherHoleEffect } from "../../src/content/effects/gopher-hole";
import { magnetEffect } from "../../src/content/effects/magnet";
import type { ClaimContext, ClaimEffect } from "../../src/content/effects/types";

function context(over: Partial<ClaimContext> = {}): ClaimContext {
  const doc = document;
  return {
    doc,
    surface: doc.createElement("span"),
    root: doc.createElement("div"),
    theme: "light",
    animations: true,
    claim: vi.fn().mockResolvedValue({ ok: true, created: true }),
    announce: vi.fn(),
    label: (verb: string) => `${verb}`,
    ...over,
  };
}

/** Each effect's own hit-animation length; play must restore when it ends. */
const DURATIONS: Array<[ClaimEffect, number]> = [
  [gopherHoleEffect, 620],
  [magnetEffect, 560],
  [catHoardEffect, 720],
  [catStickerEffect, 720],
];

describe("claim effect play()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  for (const [effect, ms] of DURATIONS) {
    it(`${effect.id} performs without claiming, then returns to its phase`, async () => {
      const ctx = context();
      const handle = effect.mount(ctx);
      handle.setState("settled");

      handle.play?.();
      expect(ctx.root.dataset.ilmtState).toBe("hit");

      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(ctx.root.dataset.ilmtState).toBe("hit");

      await vi.advanceTimersByTimeAsync(1);
      expect(ctx.root.dataset.ilmtState).toBe("settled");
      expect(ctx.claim).not.toHaveBeenCalled();
    });

    it(`${effect.id} returns to idle when nothing was claimed yet`, async () => {
      const ctx = context();
      const handle = effect.mount(ctx);

      handle.play?.();
      expect(ctx.root.dataset.ilmtState).toBe("hit");
      await vi.advanceTimersByTimeAsync(ms);
      expect(ctx.root.dataset.ilmtState).toBe("idle");
    });

    it(`${effect.id} ignores a click while it is performing`, async () => {
      const ctx = context();
      const handle = effect.mount(ctx);
      handle.play?.();

      ctx.root.querySelector("button")?.click();
      expect(ctx.claim).not.toHaveBeenCalled();
      expect(ctx.root.dataset.ilmtState).toBe("hit");

      await vi.advanceTimersByTimeAsync(ms);
      expect(ctx.root.dataset.ilmtState).toBe("idle");
    });

    it(`${effect.id} stops performing when destroyed mid-way`, async () => {
      const ctx = context();
      const handle = effect.mount(ctx);
      handle.play?.();
      handle.destroy();

      await vi.advanceTimersByTimeAsync(ms * 2);
      expect(ctx.root.dataset.ilmtState).toBe("hit");
      expect(ctx.root.querySelector("button")).toBeNull();
    });
  }
});
