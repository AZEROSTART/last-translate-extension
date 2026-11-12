/** Visual states of the claim mascot; the state machine is skin-agnostic. */
export type MascotState = "idle" | "hit" | "caught" | "known";

/**
 * A mascot is a skin only. It renders SVG and supplies copy; the card owns the
 * click, the timing and the learning write, so adding a character never
 * touches card logic.
 */
export interface MascotSkin {
  id: string;
  label: string;
  /** Verb used in the aria label, e.g. 打 → "把地鼠打下去". */
  verb: string;
  caughtLabel: string;
  knownLabel: string;
  /** Relative selection weight before fatigue adjustment. */
  weight: number;
  hitDurationMs: number;
  render(state: MascotState, theme: "light" | "dark"): SVGElement;
}
