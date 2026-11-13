import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gopherHoleEffect } from "../../src/content/effects/gopher-hole";
import type { ClaimContext } from "../../src/content/effects/types";

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
    label: (verb: string) => `把地鼠${verb}下去，收录这个单词`,
    ...over,
  };
}

describe("gopher-hole effect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("claims once, however often the head is clicked", async () => {
    const ctx = context();
    gopherHoleEffect.mount(ctx);
    const button = ctx.root.querySelector("button")!;

    button.click();
    button.click();
    expect(ctx.claim).toHaveBeenCalledTimes(1);
    expect(ctx.root.dataset.ilmtState).toBe("hit");

    await vi.advanceTimersByTimeAsync(620);
    expect(ctx.root.dataset.ilmtState).toBe("settled");
    expect(ctx.announce).toHaveBeenCalledWith("已收录");
  });

  it("settles on known when the word was already stored", async () => {
    const ctx = context({
      claim: vi.fn().mockResolvedValue({ ok: true, created: false }),
    });
    gopherHoleEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(620);
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.announce).toHaveBeenCalledWith("这个词已经在学习库里了");
  });

  it("returns to idle when the write fails", async () => {
    const ctx = context({ claim: vi.fn().mockResolvedValue({ ok: false, created: false }) });
    gopherHoleEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(620);
    expect(ctx.root.dataset.ilmtState).toBe("idle");
  });

  it("does not animate when animations are off", async () => {
    const ctx = context({ animations: false });
    gopherHoleEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.dataset.ilmtAnimations).toBe("off");
    expect(ctx.root.dataset.ilmtState).toBe("settled");
  });

  it("shows the known state without a click", () => {
    const ctx = context();
    const handle = gopherHoleEffect.mount(ctx);
    handle.setState("known");
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.claim).not.toHaveBeenCalled();
  });

  it("labels the button through the shared wording", () => {
    const ctx = context();
    gopherHoleEffect.mount(ctx);
    expect(ctx.root.querySelector("button")!.getAttribute("aria-label")).toBe(
      "把地鼠打下去，收录这个单词",
    );
  });
});
