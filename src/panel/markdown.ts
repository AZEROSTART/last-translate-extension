/**
 * XSS-safe, streaming-friendly Markdown renderer for side-panel answers.
 *
 * One linear pass over lines builds blocks, and a linear scanner builds inline
 * nodes. Everything is created with DOM APIs: model output is never parsed as
 * HTML, so `<script>`, event handlers and bare tags stay literal text.
 */

const FENCE = /^\s{0,3}```(.*)$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.+)$/;
const UNORDERED = /^\s{0,3}[-*]\s+(.+)$/;
const ORDERED = /^\s{0,3}\d+\.\s+(.+)$/;
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/;

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    UNORDERED.test(line) ||
    ORDERED.test(line) ||
    BLOCKQUOTE.test(line)
  );
}

/** Render inline spans; unclosed markers stay literal text. */
function appendInline(parent: Node, text: string, doc: Document): void {
  let index = 0;
  let buffer = "";

  const flush = (): void => {
    if (buffer.length === 0) return;
    parent.appendChild(doc.createTextNode(buffer));
    buffer = "";
  };

  while (index < text.length) {
    const char = text[index];

    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        const code = doc.createElement("code");
        code.className = "md-code";
        code.textContent = text.slice(index + 1, end);
        parent.appendChild(code);
        index = end + 1;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    if (char === "*") {
      if (text[index + 1] === "*") {
        const end = text.indexOf("**", index + 2);
        if (end > index + 2) {
          const inner = text.slice(index + 2, end);
          if (!/^\s/.test(inner) && !/\s$/.test(inner)) {
            flush();
            const strong = doc.createElement("strong");
            appendInline(strong, inner, doc);
            parent.appendChild(strong);
            index = end + 2;
            continue;
          }
        }
        buffer += char;
        index += 1;
        continue;
      }

      const end = text.indexOf("*", index + 1);
      if (end > index + 1) {
        const inner = text.slice(index + 1, end);
        // `* italic *` is not emphasis; keep the markers visible.
        if (!/^\s/.test(inner) && !/\s$/.test(inner)) {
          flush();
          const emphasis = doc.createElement("em");
          appendInline(emphasis, inner, doc);
          parent.appendChild(emphasis);
          index = end + 1;
          continue;
        }
      }
      buffer += char;
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
}

export function renderMarkdown(text: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  if (text === "") return fragment;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (FENCE.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_CLOSE.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      // An unclosed fence (mid-stream) simply runs to the end.
      if (index < lines.length) index += 1;

      const code = doc.createElement("code");
      code.textContent = codeLines.join("\n");
      const pre = doc.createElement("pre");
      pre.className = "md-pre";
      pre.appendChild(code);
      fragment.appendChild(pre);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const paragraph = doc.createElement("p");
      paragraph.className = "md-heading";
      appendInline(paragraph, heading[2], doc);
      fragment.appendChild(paragraph);
      index += 1;
      continue;
    }

    const unordered = UNORDERED.exec(line);
    if (unordered) {
      const list = doc.createElement("ul");
      list.className = "md-list";
      let item: RegExpExecArray | null = unordered;
      while (item) {
        const li = doc.createElement("li");
        appendInline(li, item[1], doc);
        list.appendChild(li);
        index += 1;
        item = index < lines.length ? UNORDERED.exec(lines[index]) : null;
      }
      fragment.appendChild(list);
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      const list = doc.createElement("ol");
      list.className = "md-list";
      let item: RegExpExecArray | null = ordered;
      while (item) {
        const li = doc.createElement("li");
        appendInline(li, item[1], doc);
        list.appendChild(li);
        index += 1;
        item = index < lines.length ? ORDERED.exec(lines[index]) : null;
      }
      fragment.appendChild(list);
      continue;
    }

    const quote = BLOCKQUOTE.exec(line);
    if (quote) {
      const quoted: string[] = [];
      let current: RegExpExecArray | null = quote;
      while (current) {
        quoted.push(current[1]);
        index += 1;
        current = index < lines.length ? BLOCKQUOTE.exec(lines[index]) : null;
      }
      const blockquote = doc.createElement("blockquote");
      blockquote.className = "md-quote";
      appendInline(blockquote, quoted.join("\n"), doc);
      fragment.appendChild(blockquote);
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = doc.createElement("p");
    paragraph.className = "md-p";
    appendInline(paragraph, paragraphLines.join("\n"), doc);
    fragment.appendChild(paragraph);
  }

  return fragment;
}
