/**
 * Paragraph ↔ translation linkage: hovering a source block lights only the
 * `.ilmt-tr` nodes that belong to it, via the `data-ilmt-peer` attribute.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContentMain, setPeerTranslation } from "../../src/content/main";

beforeEach(async () => {
  document.body.innerHTML = "";
  // Install the delegated hover listeners the way activation does (scanning an
  // empty body is enough); each test then builds its own paragraph markup.
  runContentMain();
  (globalThis as any).__ilmtTestPort = { send: () => {} };
  await (globalThis as any).__ilmtMain.translatePage();
  document.body.innerHTML = "";
});

afterEach(() => {
  (globalThis as any).__ilmtMain?.restore();
  delete (globalThis as any).__ilmtTestPort;
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

function firePointer(
  type: "pointerover" | "pointerout",
  target: Element,
  relatedTarget: Element | null = null,
): void {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

describe("row-flex sibling translations", () => {
  it("stays lit while moving root → sibling .ilmt-tr → root", () => {
    document.body.innerHTML = `
      <div id="row" data-ilmt-p="p_1">Source row text</div>
      <span id="tr" class="ilmt-tr" data-ilmt-for="p_1">译文</span>
      <span id="outside">outside</span>`;
    const row = document.getElementById("row")!;
    const tr = document.getElementById("tr")!;
    const outside = document.getElementById("outside")!;

    firePointer("pointerover", row);
    expect(tr.getAttribute("data-ilmt-peer")).toBe("1");

    // Leaving the root toward its own (sibling) translation must not clear it.
    firePointer("pointerout", row, tr);
    expect(tr.getAttribute("data-ilmt-peer")).toBe("1");

    firePointer("pointerover", tr);
    expect(tr.getAttribute("data-ilmt-peer")).toBe("1");

    firePointer("pointerout", tr, row);
    expect(tr.getAttribute("data-ilmt-peer")).toBe("1");

    firePointer("pointerover", row);
    expect(tr.getAttribute("data-ilmt-peer")).toBe("1");

    firePointer("pointerout", row, outside);
    expect(tr.getAttribute("data-ilmt-peer")).toBeNull();
  });

  it("lights all sibling translations when hovering one .ilmt-tr directly", () => {
    document.body.innerHTML = `
      <div id="row" data-ilmt-p="p_3 p_4">Source row text</div>
      <span id="tr3" class="ilmt-tr" data-ilmt-for="p_3">译文三</span>
      <span id="tr4" class="ilmt-tr" data-ilmt-for="p_4">译文四</span>
      <span id="other" class="ilmt-tr" data-ilmt-for="p_9">别的</span>`;
    const tr3 = document.getElementById("tr3")!;
    const tr4 = document.getElementById("tr4")!;
    const other = document.getElementById("other")!;

    firePointer("pointerover", tr4);
    expect(tr3.getAttribute("data-ilmt-peer")).toBe("1");
    expect(tr4.getAttribute("data-ilmt-peer")).toBe("1");
    expect(other.getAttribute("data-ilmt-peer")).toBeNull();

    firePointer("pointerout", tr4, other);
    expect(tr3.getAttribute("data-ilmt-peer")).toBeNull();
    expect(tr4.getAttribute("data-ilmt-peer")).toBeNull();
  });

  it("clears peer marks and removes hover listeners on restore", () => {
    document.body.innerHTML = `
      <div id="row" data-ilmt-p="p_1">Source row text</div>
      <span id="tr" class="ilmt-tr" data-ilmt-for="p_1">译文</span>`;
    const row = document.getElementById("row")!;

    firePointer("pointerover", row);
    expect(document.getElementById("tr")!.getAttribute("data-ilmt-peer")).toBe("1");

    (globalThis as any).__ilmtMain.restore();

    expect(document.querySelectorAll(".ilmt-tr[data-ilmt-peer]")).toHaveLength(0);

    // The delegated listeners are gone: a fresh translation cannot be lit
    // without a new activation.
    row.setAttribute("data-ilmt-p", "p_1");
    document.body.insertAdjacentHTML(
      "beforeend",
      `<span id="tr2" class="ilmt-tr" data-ilmt-for="p_1">译文</span>`,
    );
    firePointer("pointerover", row);
    expect(document.getElementById("tr2")!.getAttribute("data-ilmt-peer")).toBeNull();
  });
});
