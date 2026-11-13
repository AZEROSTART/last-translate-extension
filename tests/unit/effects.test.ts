import { describe, expect, it } from "vitest";
import {
  getEffect,
  getEffects,
  pickEffect,
  registerEffect,
} from "../../src/content/effects";
import type { ClaimEffect } from "../../src/content/effects/types";

function effect(id: string): ClaimEffect {
  return {
    id,
    label: id,
    summary: `${id} summary`,
    reserve: { above: 0, below: 0 },
    mount: () => ({ setState: () => {}, destroy: () => {} }),
  };
}

registerEffect(effect("a"));
registerEffect(effect("b"));
registerEffect(effect("c"));

describe("effect registry", () => {
  it("registers effects and overwrites the same id", () => {
    registerEffect({ ...effect("a"), label: "A2" });
    expect(getEffect("a")?.label).toBe("A2");
    expect(getEffects()).toHaveLength(3);
  });

  it("ignores unknown enabled ids and falls back to every effect", () => {
    registerEffect(effect("a"));
    const picked = pickEffect({ enabledIds: ["gone"], lastPicks: [], seed: 1 });
    expect(["a", "b", "c"]).toContain(picked.id);
  });

  it("never repeats the last two picks", () => {
    const picked = pickEffect({ enabledIds: ["a", "b", "c"], lastPicks: ["a", "b"], seed: 1 });
    expect(picked.id).toBe("c");
  });

  it("falls back when the only enabled effect was just used", () => {
    expect(pickEffect({ enabledIds: ["a"], lastPicks: ["a"], seed: 2 }).id).toBe("a");
  });

  it("rotates evenly across three effects", () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const lastPicks: string[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      const picked = pickEffect({ enabledIds: ["a", "b", "c"], lastPicks, seed: i + 1 });
      counts[picked.id] += 1;
      lastPicks.push(picked.id);
      if (lastPicks.length > 2) lastPicks.shift();
    }
    for (const id of ["a", "b", "c"]) {
      expect(counts[id] / 3_000).toBeGreaterThan(0.28);
      expect(counts[id] / 3_000).toBeLessThan(0.39);
    }
  });
});
