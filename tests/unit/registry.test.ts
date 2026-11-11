import { describe, it, expect } from "vitest";
import { ParagraphRegistry } from "../../src/content/registry";

function add(r: ParagraphRegistry, id: string, el: Element, anchor: Node = el, heading = false) {
  r.add({ id, el, anchor, text: "hello", heading });
}

describe("ParagraphRegistry", () => {
  it("transitions through queued → inflight → done", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<p></p>`;
    add(r, "p_1", document.querySelector("p")!);
    r.setStatus("p_1", "queued"); expect(r.get("p_1")!.status).toBe("queued");
    r.setStatus("p_1", "inflight"); r.setStatus("p_1", "done");
    expect(r.get("p_1")!.status).toBe("done");
  });

  it("requeues inflight items on disconnect", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<p></p><p></p>`;
    const [a, b] = Array.from(document.querySelectorAll("p"));
    add(r, "p_1", a); add(r, "p_2", b);
    r.setStatus("p_1", "inflight"); r.setStatus("p_2", "inflight");
    expect(r.requeueInflight().sort()).toEqual(["p_1", "p_2"]);
    expect(r.get("p_1")!.status).toBe("queued");
  });

  it("prunes records whose element left the document", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<p></p>`;
    const el = document.querySelector("p")!;
    add(r, "p_1", el);
    el.remove();
    expect(r.prune()).toBe(1);
    expect(r.get("p_1")).toBeUndefined();
  });

  it("takes queued paragraphs FIFO up to the limit and marks them inflight", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<p></p><p></p><p></p>`;
    const [a, b, c] = Array.from(document.querySelectorAll("p"));
    add(r, "p_1", a); add(r, "p_2", b); add(r, "p_3", c);
    r.setStatus("p_1", "queued");
    r.setStatus("p_2", "queued");
    r.setStatus("p_3", "queued");

    const taken = r.takeQueued(2);

    expect(taken.map((rec) => rec.id)).toEqual(["p_1", "p_2"]);
    expect(taken.every((rec) => rec.status === "inflight")).toBe(true);
    expect(r.get("p_3")!.status).toBe("queued");
  });

  it("records the source text and sets a translation", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<p></p>`;
    const el = document.querySelector("p")!;
    r.add({ id: "p_1", el, anchor: el, text: "Hello world", heading: false });

    expect(r.get("p_1")!.sourceText).toBe("Hello world");
    r.setTranslation("p_1", "你好世界");
    expect(r.get("p_1")!.translation).toBe("你好世界");
  });

  it("returns every record from all()", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<p></p><p></p>`;
    const [a, b] = Array.from(document.querySelectorAll("p"));
    add(r, "p_1", a); add(r, "p_2", b);
    expect(r.all().map((rec) => rec.id).sort()).toEqual(["p_1", "p_2"]);
  });

  it("stores the anchor and heading flag", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<h1>Title</h1>`;
    const h1 = document.querySelector("h1")!;
    r.add({
      id: "p_1",
      el: h1,
      anchor: h1.firstChild!,
      text: "Title",
      heading: true,
    });
    expect(r.get("p_1")!.heading).toBe(true);
    expect(r.get("p_1")!.anchor.deref()).toBe(h1.firstChild!);
  });

  it("prunes when the anchor leaves even though the root stays", () => {
    const r = new ParagraphRegistry();
    document.body.innerHTML = `<p>hello</p>`;
    const p = document.querySelector("p")!;
    const anchor = p.firstChild!;
    r.add({ id: "p_1", el: p, anchor, text: "hello", heading: false });
    anchor.parentNode!.removeChild(anchor);
    expect(r.prune()).toBe(1);
    expect(r.get("p_1")).toBeUndefined();
  });
});

it("stores text-node refs and glossary notes", () => {
  const r = new ParagraphRegistry();
  document.body.innerHTML = `<p>Hello world.</p>`;
  const p = document.querySelector("p")!;
  const text = p.firstChild!;
  r.add({
    id: "p_1",
    el: p,
    anchor: text,
    text: "Hello world.",
    heading: false,
    textNodes: [text],
  });
  expect(r.get("p_1")!.textNodes.map((ref) => ref.deref())).toEqual([text]);
  r.setGlossary("p_1", [{ surface: "Hello", meaning: "你好" }]);
  expect(r.get("p_1")!.glossary).toEqual([{ surface: "Hello", meaning: "你好" }]);
});
