import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catHoardEffect } from "../../src/content/effects/cat-hoard";
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
    label: (verb: string) => `把${catHoardEffect.label}${verb}下去，收录这个单词`,
    ...over,
  };
}

describe("cat-hoard effect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("claims once, however often the cat is clicked", async () => {
    const ctx = context();
    catHoardEffect.mount(ctx);
    const button = ctx.root.querySelector("button")!;

    button.click();
    button.click();
    expect(ctx.claim).toHaveBeenCalledTimes(1);
    expect(ctx.root.dataset.ilmtState).toBe("hit");

    await vi.advanceTimersByTimeAsync(720);
    expect(ctx.root.dataset.ilmtState).toBe("settled");
    expect(ctx.announce).toHaveBeenCalledWith("已收录");
  });

  it("settles on known when the word was already stored", async () => {
    const ctx = context({
      claim: vi.fn().mockResolvedValue({ ok: true, created: false }),
    });
    catHoardEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(720);
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.announce).toHaveBeenCalledWith("这个词已经在学习库里了");
  });

  it("returns to idle and announces the failure when the write fails", async () => {
    const ctx = context({ claim: vi.fn().mockResolvedValue({ ok: false, created: false }) });
    catHoardEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(720);
    expect(ctx.root.dataset.ilmtState).toBe("idle");
    expect(ctx.announce).toHaveBeenCalledWith("收录失败");
  });

  it("treats a rejected claim as a failure", async () => {
    const ctx = context({ claim: vi.fn().mockRejectedValue(new Error("offline")) });
    catHoardEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(720);
    expect(ctx.root.dataset.ilmtState).toBe("idle");
    expect(ctx.announce).toHaveBeenCalledWith("收录失败");
  });

  it("does not animate when animations are off", async () => {
    const ctx = context({ animations: false });
    catHoardEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.dataset.ilmtAnimations).toBe("off");
    expect(ctx.root.dataset.ilmtState).toBe("settled");
  });

  it("shows the known state without a click", () => {
    const ctx = context();
    const handle = catHoardEffect.mount(ctx);
    handle.setState("known");
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.claim).not.toHaveBeenCalled();
  });

  it("labels the button through the shared wording", () => {
    const ctx = context();
    catHoardEffect.mount(ctx);
    expect(ctx.root.querySelector("button")!.getAttribute("aria-label")).toBe(
      "把怀里猫按下去，收录这个单词",
    );
  });

  it("does not claim again when the settled cat is clicked", async () => {
    const ctx = context();
    catHoardEffect.mount(ctx);
    const button = ctx.root.querySelector("button")!;

    button.click();
    await vi.advanceTimersByTimeAsync(720);
    expect(ctx.root.dataset.ilmtState).toBe("settled");

    button.click();
    expect(ctx.claim).toHaveBeenCalledTimes(1);
    expect(ctx.root.dataset.ilmtState).toBe("settled");
  });

  it("clears the pending settle timer on destroy", async () => {
    const ctx = context();
    const handle = catHoardEffect.mount(ctx);

    ctx.root.querySelector("button")!.click();
    handle.destroy();
    await vi.advanceTimersByTimeAsync(2000);

    expect(ctx.root.dataset.ilmtState).toBe("hit");
    expect(ctx.root.querySelector("button")).toBeNull();
    expect(ctx.announce).not.toHaveBeenCalled();
  });

  it("gives every mount its own DOM, with no shared element ids", () => {
    const first = context();
    const second = context();
    catHoardEffect.mount(first);
    catHoardEffect.mount(second);

    expect(first.root.querySelector("button")).not.toBe(second.root.querySelector("button"));
    expect(first.root.querySelectorAll("[id]")).toHaveLength(0);
    expect(first.root.querySelector('[class*="fx-chip"]')).not.toBeNull();
  });

  it("describes itself for the settings page", () => {
    expect(catHoardEffect.id).toBe("cat-hoard");
    expect(catHoardEffect.label).toBe("怀里猫");
    expect(catHoardEffect.summary.length).toBeGreaterThan(0);
    expect(catHoardEffect.reserve).toEqual({ above: 0, below: 60 });
  });

  it("is registered by every surface that mounts claim effects", async () => {
    const surfaces = [
      "../../src/content/glossary",
      "../../src/panel/review",
      "../../src/settings/sections/learning",
    ];
    for (const path of surfaces) {
      vi.resetModules();
      await import(path);
      const { getEffect } = await import("../../src/content/effects");
      expect(getEffect("cat-hoard"), path).toBeTruthy();
    }
  });
});
