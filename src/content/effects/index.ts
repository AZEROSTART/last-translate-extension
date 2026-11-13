import type { ClaimEffect } from "./types";

export type {
  ClaimContext,
  ClaimEffect,
  ClaimHandle,
  ClaimPhase,
  ClaimResult,
} from "./types";

const effects: ClaimEffect[] = [];

/** Register at module load. Re-registering an id replaces the previous effect. */
export function registerEffect(effect: ClaimEffect): void {
  const index = effects.findIndex((item) => item.id === effect.id);
  if (index >= 0) effects[index] = effect;
  else effects.push(effect);
}

export function getEffects(): ClaimEffect[] {
  return [...effects];
}

export function getEffect(id: string): ClaimEffect | undefined {
  return effects.find((effect) => effect.id === id);
}

/** Small deterministic PRNG so rotation can be unit-tested. */
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

export interface PickEffectOptions {
  /** Empty = every registered effect. Unknown ids are ignored. */
  enabledIds: string[];
  /** Most recent picks, newest last; the last two are avoided. */
  lastPicks: string[];
  seed?: number;
}

/** Pick an effect, avoiding the last two picks unless that leaves nothing. */
export function pickEffect(options: PickEffectOptions): ClaimEffect {
  const enabled = options.enabledIds
    .map((id) => getEffect(id))
    .filter((effect): effect is ClaimEffect => effect !== undefined);
  const pool = enabled.length > 0 ? enabled : [...effects];
  if (pool.length === 0) throw new Error("No claim effect registered");

  const recent = new Set(options.lastPicks.slice(-2));
  const fresh = pool.filter((effect) => !recent.has(effect.id));
  const candidates = fresh.length > 0 ? fresh : pool;

  const random = options.seed === undefined ? Math.random : mulberry32(options.seed);
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index];
}
