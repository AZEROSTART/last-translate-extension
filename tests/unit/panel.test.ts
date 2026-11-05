import { describe, it, expect } from "vitest";
import { createSession, appendMessage, buildChatContext } from "../../src/panel/session";

describe("panel session", () => {
  it("pins the session to the page where it started", () => {
    const s = createSession("https://a.test/x", "A", 1);
    expect(s.pageUrl).toBe("https://a.test/x");
    expect(s.pageTitle).toBe("A");
    expect(s.tabId).toBe(1);
    expect(s.messages).toEqual([]);
  });

  it("appends messages in order without mutating the previous session", () => {
    const s0 = createSession("u", "t", 1);
    const s1 = appendMessage(s0, { role: "user", content: "hi", ts: 1 });
    const s2 = appendMessage(s1, { role: "assistant", content: "hello", ts: 2 });

    expect(s0.messages).toEqual([]);
    expect(s1.messages.map((m) => m.content)).toEqual(["hi"]);
    expect(s2.messages.map((m) => m.content)).toEqual(["hi", "hello"]);
  });

  it("keeps at most 50 messages", () => {
    let s = createSession("u", "t", 1);
    for (let i = 0; i < 60; i++) s = appendMessage(s, { role: "user", content: String(i), ts: i });
    expect(s.messages).toHaveLength(50);
    expect(s.messages[0].content).toBe("10");
    expect(s.messages.at(-1)!.content).toBe("59");
  });

  it("puts only the last five paragraphs into the context", () => {
    const paragraphs = Array.from({ length: 9 }, (_, i) => ({ source: `s${i}`, translation: `t${i}` }));
    const ctx = buildChatContext(createSession("u", "t", 1), ["quote"], paragraphs);
    expect(ctx.recentParagraphs).toHaveLength(5);
    expect(ctx.recentParagraphs[0].source).toBe("s4");
    expect(ctx.quotes).toEqual(["quote"]);
  });

  it("carries page url/title and quotes into the context", () => {
    const s = createSession("https://a.test/p", "Page", 7);
    const ctx = buildChatContext(s, ["a", "b"], []);
    expect(ctx.pageUrl).toBe("https://a.test/p");
    expect(ctx.title).toBe("Page");
    expect(ctx.quotes).toEqual(["a", "b"]);
    expect(ctx.recentParagraphs).toEqual([]);
  });

  it("keeps all paragraphs when fewer than five are available", () => {
    const paragraphs = [
      { source: "s0", translation: "t0" },
      { source: "s1", translation: "t1" },
    ];
    const ctx = buildChatContext(createSession("u", "t", 1), [], paragraphs);
    expect(ctx.recentParagraphs).toHaveLength(2);
  });
});
