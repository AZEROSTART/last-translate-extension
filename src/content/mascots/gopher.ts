import { registerMascot } from "./index";
import type { MascotSkin, MascotState } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

function node<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

/**
 * The first claim mascot: a gopher half out of its hole. Pure inline SVG so a
 * page CSP can never block it.
 */
export const gopherSkin: MascotSkin = {
  id: "gopher",
  label: "地鼠",
  verb: "打",
  caughtLabel: "已抓住",
  knownLabel: "已在学习中",
  weight: 1,
  hitDurationMs: 180,
  render(state: MascotState, theme: "light" | "dark"): SVGElement {
    const fur = theme === "dark" ? "#b98a63" : "#a97a52";
    const furLight = theme === "dark" ? "#d8b08a" : "#c99a71";
    const hole = theme === "dark" ? "#0f172a" : "#1f2937";

    const svg = node("svg", {
      viewBox: "0 0 44 44",
      width: "36",
      height: "36",
      "aria-hidden": "true",
      focusable: "false",
    });
    svg.classList.add("ilmt-gloss-gopher");
    if (state === "hit") svg.classList.add("ilmt-gloss-gopher-hit");

    // Hole, body, muzzle and eyes. Kept under ~10 elements so a hover card
    // still feels instant on low-end devices.
    svg.append(node("ellipse", { cx: "22", cy: "37", rx: "17", ry: "5", fill: hole }));
    svg.append(node("circle", { cx: "22", cy: "26", r: "11", fill: fur }));
    svg.append(node("ellipse", { cx: "22", cy: "30", rx: "7", ry: "5", fill: furLight }));
    svg.append(node("circle", { cx: "18", cy: "23", r: "1.8", fill: "#1f2937" }));
    svg.append(node("circle", { cx: "26", cy: "23", r: "1.8", fill: "#1f2937" }));
    svg.append(node("circle", { cx: "22", cy: "29", r: "1.6", fill: "#1f2937" }));
    svg.append(node("ellipse", { cx: "14", cy: "36", rx: "4", ry: "3", fill: fur }));
    svg.append(node("ellipse", { cx: "30", cy: "36", rx: "4", ry: "3", fill: fur }));

    if (state === "caught") {
      const badge = node("text", {
        x: "34",
        y: "12",
        "text-anchor": "middle",
        "font-size": "10",
        "font-weight": "700",
        fill: "#2dd4bf",
      });
      badge.textContent = "+1";
      svg.append(badge);
    } else if (state === "known") {
      const check = node("path", {
        d: "M33 9 l2.5 3 L41 5",
        fill: "none",
        stroke: "#2dd4bf",
        "stroke-width": "2.2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
      svg.append(check);
    }

    return svg;
  },
};

registerMascot(gopherSkin);

// Placeholders for future characters. Adding one only needs a new skin module
// and a registerMascot() call; the hover card never learns about the id.
// export const catSkin: MascotSkin = { ... };
// export const frogSkin: MascotSkin = { ... };
