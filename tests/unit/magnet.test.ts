import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEffect } from "../../src/content/effects";
import { magnetEffect } from "../../src/content/effects/magnet";
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
    label: (verb: string) => `把磁铁${verb}下去，收录这个单词`,
    ...over,
  };
}

describe("magnet effect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("registers itself under its own id", () => {
    expect(getEffect("magnet")).toBe(magnetEffect);
  });

  it("claims once, however often the magnet is clicked", async () => {
    const ctx = context();
    magnetEffect.mount(ctx);
    const button = ctx.root.querySelector("button")!;

    button.click();
    button.click();
    expect(ctx.claim).toHaveBeenCalledTimes(1);
    expect(ctx.root.dataset.ilmtState).toBe("hit");

    await vi.advanceTimersByTimeAsync(560);
    expect(ctx.root.dataset.ilmtState).toBe("settled");
    expect(ctx.announce).toHaveBeenCalledWith("已收录");
  });

  it("settles on known when the word was already stored", async () => {
    const ctx = context({
      claim: vi.fn().mockResolvedValue({ ok: true, created: false }),
    });
    magnetEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(560);
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.announce).toHaveBeenCalledWith("这个词已经在学习库里了");
  });

  it("returns to idle and announces the failure when the write fails", async () => {
    const ctx = context({ claim: vi.fn().mockResolvedValue({ ok: false, created: false }) });
    magnetEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(560);
    expect(ctx.root.dataset.ilmtState).toBe("idle");
    expect(ctx.announce).toHaveBeenCalledWith("收录失败");
  });

  it("does not animate when animations are off", async () => {
    const ctx = context({ animations: false });
    magnetEffect.mount(ctx);
    ctx.root.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.dataset.ilmtAnimations).toBe("off");
    expect(ctx.root.dataset.ilmtState).toBe("settled");
  });

  it("shows the known state without a click", () => {
    const ctx = context();
    const handle = magnetEffect.mount(ctx);
    handle.setState("known");
    expect(ctx.root.dataset.ilmtState).toBe("known");
    expect(ctx.claim).not.toHaveBeenCalled();
  });

  it("labels the button through the shared wording", () => {
    const ctx = context();
    magnetEffect.mount(ctx);
    expect(ctx.root.querySelector("button")!.getAttribute("aria-label")).toBe(
      "把磁铁按下去，收录这个单词",
    );
  });

  it("does not claim again when the settled magnet is clicked", async () => {
    const ctx = context();
    magnetEffect.mount(ctx);
    const button = ctx.root.querySelector("button")!;

    button.click();
    await vi.advanceTimersByTimeAsync(560);
    expect(ctx.root.dataset.ilmtState).toBe("settled");

    button.click();
    expect(ctx.claim).toHaveBeenCalledTimes(1);
    expect(ctx.root.dataset.ilmtState).toBe("settled");
  });

  it("gives every iron filing its own pull vector", () => {
    const ctx = context();
    magnetEffect.mount(ctx);
    const filings = [...ctx.root.querySelectorAll<SVGElement>(".ilmt-gloss-fx-filing")];
    expect(filings.length).toBeGreaterThanOrEqual(4);
    for (const filing of filings) {
      expect(filing.style.getPropertyValue("--dx")).toMatch(/^-?\d+(\.\d+)?px$/);
      expect(filing.style.getPropertyValue("--dy")).toMatch(/^-?\d+(\.\d+)?px$/);
    }
  });

  it("keeps the caught pellet inside the horseshoe opening", () => {
    const ctx = context();
    magnetEffect.mount(ctx);
    const pellet = ctx.root.querySelector(".ilmt-gloss-fx-caught circle")!;
    expect(Number(pellet.getAttribute("cx"))).toBe(25);
    expect(Number(pellet.getAttribute("cy"))).toBe(24);
    // The body is drawn before the filings, so the filings pass in front.
    const body = ctx.root.querySelector(".ilmt-gloss-fx-body")!;
    const filings = ctx.root.querySelector(".ilmt-gloss-fx-filings")!;
    expect(body.compareDocumentPosition(filings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
