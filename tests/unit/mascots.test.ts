import { describe, expect, it } from "vitest";
import { getMascot, getMascots, pickMascot, registerMascot } from "../../src/content/mascots";
import type { MascotSkin } from "../../src/content/mascots/types";

function skin(id: string, weight = 1): MascotSkin {
  return {
    id,
    label: id,
    verb: "打",
    caughtLabel: "已抓住",
    knownLabel: "已在学习中",
    weight,
    hitDurationMs: 180,
    render: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"),
  };
}

registerMascot(skin("a"));
registerMascot(skin("b"));
registerMascot(skin("c"));

describe("registry", () => {
  it("registers skins and overwrites the same id", () => {
    registerMascot({ ...skin("a"), label: "A2" });
    expect(getMascot("a")?.label).toBe("A2");
    expect(getMascots()).toHaveLength(3);
  });
});

describe("pickMascot", () => {
  it("never repeats the last two picks", () => {
    const picked = pickMascot({ enabledIds: ["a", "b", "c"], lastPicks: ["a", "b"], seed: 1 });
    expect(picked.id).toBe("c");
  });

  it("falls back when the only enabled skin was just used", () => {
    expect(pickMascot({ enabledIds: ["a"], lastPicks: ["a"], seed: 2 }).id).toBe("a");
  });

  it("returns the fixed skin when it is the only candidate", () => {
    expect(pickMascot({ enabledIds: ["b"], lastPicks: [], seed: 3 }).id).toBe("b");
  });

  it("spreads picks as misses accumulate", () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const lastPicks: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const picked = pickMascot({ enabledIds: ["a", "b", "c"], lastPicks, seed: i + 1 });
      counts[picked.id] += 1;
      lastPicks.push(picked.id);
      if (lastPicks.length > 2) lastPicks.shift();
    }
    for (const id of ["a", "b", "c"]) {
      const share = counts[id] / 10_000;
      expect(share).toBeGreaterThan(0.25);
      expect(share).toBeLessThan(0.42);
    }
  });
});
