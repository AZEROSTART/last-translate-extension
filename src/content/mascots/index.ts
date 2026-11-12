import type { MascotSkin } from "./types";

export type { MascotSkin, MascotState } from "./types";

const skins: MascotSkin[] = [];

/** Register at module load. Re-registering an id replaces the previous skin. */
export function registerMascot(skin: MascotSkin): void {
  const index = skins.findIndex((item) => item.id === skin.id);
  if (index >= 0) skins[index] = skin;
  else skins.push(skin);
}

export function getMascots(): MascotSkin[] {
  return [...skins];
}

export function getMascot(id: string): MascotSkin | undefined {
  return skins.find((skin) => skin.id === id);
}

/** Small deterministic PRNG so weighted picks can be unit-tested. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PickOptions {
  /** Empty = every registered mascot. */
  enabledIds: string[];
  /** Most recent picks, newest last; the last two are avoided. */
  lastPicks: string[];
  seed?: number;
}

/**
 * Pick a skin, avoiding the last two picks unless that leaves nothing. Kept
 * skins accrue a small weight bonus for every recent slot they were skipped
 * in, which evens out long sessions without hiding a favourite character.
 */
export function pickMascot(options: PickOptions): MascotSkin {
  const enabled =
    options.enabledIds.length > 0
      ? options.enabledIds
          .map((id) => getMascot(id))
          .filter((skin): skin is MascotSkin => skin !== undefined)
      : [...skins];
  const pool = enabled.length > 0 ? enabled : [...skins];
  if (pool.length === 0) throw new Error("No mascot registered");

  const recent = new Set(options.lastPicks.slice(-2));
  const fresh = pool.filter((skin) => !recent.has(skin.id));
  const candidates = fresh.length > 0 ? fresh : pool;

  const weights = candidates.map((skin) => {
    const misses = options.lastPicks.slice(-2).filter((id) => id !== skin.id).length;
    return Math.max(0, skin.weight) * (1 + 0.5 * misses);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  const random = options.seed === undefined ? Math.random : mulberry32(options.seed);
  let roll = random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll < 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}
