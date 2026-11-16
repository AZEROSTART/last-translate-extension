/**
 * Paragraph ↔ translation linkage: hovering a source block lights only the
 * `.ilmt-tr` nodes that belong to it, via the `data-ilmt-peer` attribute.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { setPeerTranslation } from "../../src/content/main";

beforeEach(() => {
  document.body.innerHTML = "";
});

function peerOf(id: string): string | null {
  return document.querySelector(`.ilmt-tr[data-ilmt-for="${id}"]`)!.getAttribute("data-ilmt-peer");
}

describe("setPeerTranslation", () => {
  it("marks only the hovered paragraph's own translation", () => {
    document.body.innerHTML = `
      <div id="p3" data-ilmt-p="p_3">原文三段<span class="ilmt-tr" data-ilmt-for="p_3">译文三段</span></div>
      <div id="p2" data-ilmt-p="p_2">原文二段<span class="ilmt-tr" data-ilmt-for="p_2">译文二段</span></div>`;

    setPeerTranslation(document.querySelector("#p3"));

    expect(peerOf("p_3")).toBe("1");
    expect(peerOf("p_2")).toBeNull();
    expect(document.querySelectorAll(".ilmt-tr[data-ilmt-peer]")).toHaveLength(1);
  });

  it("lights every translation when one root owns several ids", () => {
    document.body.innerHTML = `
      <div id="p3" data-ilmt-p="p_3 p_4">原文<br>续段
        <span class="ilmt-tr" data-ilmt-for="p_3">译文三段</span>
        <span class="ilmt-tr" data-ilmt-for="p_4">译文四段</span>
      </div>
      <div id="p5" data-ilmt-p="p_5">原文五段<span class="ilmt-tr" data-ilmt-for="p_5">译文五段</span></div>`;

    setPeerTranslation(document.querySelector("#p3"));

    expect(peerOf("p_3")).toBe("1");
    expect(peerOf("p_4")).toBe("1");
    expect(peerOf("p_5")).toBeNull();
  });

  it("keeps at most one paragraph lit when moving to another root", () => {
    document.body.innerHTML = `
      <div id="p3" data-ilmt-p="p_3">原文三段<span class="ilmt-tr" data-ilmt-for="p_3">译文三段</span></div>
      <div id="p5" data-ilmt-p="p_5">原文五段<span class="ilmt-tr" data-ilmt-for="p_5">译文五段</span></div>`;

    setPeerTranslation(document.querySelector("#p3"));
    setPeerTranslation(document.querySelector("#p5"));

    expect(peerOf("p_3")).toBeNull();
    expect(peerOf("p_5")).toBe("1");
    expect(document.querySelectorAll(".ilmt-tr[data-ilmt-peer]")).toHaveLength(1);
  });

  it("clears every mark when passed null", () => {
    document.body.innerHTML = `
      <div id="p3" data-ilmt-p="p_3">原文三段<span class="ilmt-tr" data-ilmt-for="p_3">译文三段</span></div>
      <div id="p5" data-ilmt-p="p_5">原文五段<span class="ilmt-tr" data-ilmt-for="p_5">译文五段</span></div>`;

    setPeerTranslation(document.querySelector("#p3"));
    setPeerTranslation(null);

    expect(document.querySelectorAll(".ilmt-tr[data-ilmt-peer]")).toHaveLength(0);
  });
});
