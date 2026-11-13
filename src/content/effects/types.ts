/**
 * A claim effect is one thing: a click on the word turns into one learning
 * write. How that click looks, how long it takes and what is left on screen
 * afterwards belongs to the effect; the card only guarantees the write.
 */

/** Visible phases. `settled` = this reveal just claimed the word. */
export type ClaimPhase = "idle" | "settled" | "known";

export interface ClaimResult {
  ok: boolean;
  /** false = the word was already in the store; nothing was written. */
  created: boolean;
}

export interface ClaimContext {
  doc: Document;
  /** The word shown on the card. Effects anchor to it; previews pass a stand-in. */
  surface: HTMLElement;
  /** Container the effect fills. The caller owns its position and size. */
  root: HTMLElement;
  theme: "light" | "dark";
  /** False when the user disabled animations or prefers-reduced-motion is on. */
  animations: boolean;
  /** Claim the current word. Idempotent: repeat calls never write twice. */
  claim(): Promise<ClaimResult>;
  /** Screen-reader announcement; the caller supplies the live region. */
  announce(text: string): void;
  /** Shared aria-label wording, so every effect reads consistently. */
  label(verb: string): string;
}

export interface ClaimHandle {
  /** Called with `known` when the word was already captured earlier. */
  setState(phase: ClaimPhase): void;
  /** Clear timers and listeners; the caller removes the DOM. */
  destroy(): void;
}

export interface ClaimEffect {
  id: string;
  /** Settings-page name, e.g. 洞口地鼠. */
  label: string;
  /** One line shown under the name on the settings page. */
  summary: string;
  /** Pixels the card must reserve above and below the word row. */
  reserve: { above: number; below: number };
  /** Scoped to [data-ilmt-effect="<id>"]; injected once by the card. */
  css?: string;
  mount(ctx: ClaimContext): ClaimHandle;
}
