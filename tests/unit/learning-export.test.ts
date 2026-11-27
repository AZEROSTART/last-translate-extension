import { describe, expect, it } from "vitest";
import {
  escapeCsvCell,
  exportFilename,
  exportLearningCsv,
  exportLearningJson,
} from "../../src/shared/learning-export";
import {
  emptyLearningState,
  localDay,
  parseLearningState,
} from "../../src/shared/learning-storage";
import type { LearningState, LearningWord } from "../../src/shared/types";

const NOW = 1_700_000_000_000;

function word(over: Partial<LearningWord> = {}): LearningWord {
  return {
    id: "en:outlive",
    termLang: "en",
    surface: "outlive",
    pos: "v.",
    glosses: [
      { lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW },
      { lang: "es", meaning: "sobrevivir", source: "translation", at: NOW },
    ],
    glossLang: "zh",
    contexts: [
      {
        sentence: "Small tools often outlive their competitors.",
        pageUrl: "https://example.test/story",
        pageTitle: "Story",
        at: NOW,
      },
    ],
    status: "learning",
    box: 1,
    dueAt: NOW + 1000,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    reviews: [],
    reviewsCount: 1,
    correctCount: 1,
    checksSinceSpot: 1,
    ...over,
  };
}

describe("escapeCsvCell", () => {
  it("neutralizes every formula start before quoting", () => {
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
    expect(escapeCsvCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(escapeCsvCell("-2+3")).toBe("'-2+3");
    expect(escapeCsvCell("@cmd")).toBe("'@cmd");
    expect(escapeCsvCell("\tcmd")).toBe("'\tcmd");
    expect(escapeCsvCell("\rcmd")).toBe('"\'\rcmd"');
  });

  it("quotes commas, quotes and newlines per RFC 4180", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCsvCell("line\rbreak")).toBe('"line\rbreak"');
  });
});

describe("exportLearningCsv", () => {
  it("starts with a BOM and the exact header", () => {
    const csv = exportLearningCsv([word()]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.split("\r\n")[0]).toBe(
      "\uFEFFword,pos,meaning,language,status,sentence,source_url",
    );
  });

  it("uses the preferred language and the newest context", () => {
    const csv = exportLearningCsv([word()], "es");
    const row = csv.split("\r\n")[1].split(",");
    expect(row[0]).toBe("outlive");
    expect(row[1]).toBe("v.");
    expect(row[2]).toBe("sobrevivir");
    expect(row[3]).toBe("en");
    expect(row[4]).toBe("learning");
    expect(row[5]).toBe("Small tools often outlive their competitors.");
    expect(row[6]).toBe("https://example.test/story");
  });

  it("escapes every cell, including the sentence and source", () => {
    const csv = exportLearningCsv([
      word({
        surface: "a,b",
        glosses: [{ lang: "zh", meaning: 'say "yes"', source: "lookup", at: NOW }],
        contexts: [
          {
            sentence: "one, two\nthree",
            pageUrl: "https://example.test/a?x=1,y=2",
            at: NOW,
          },
        ],
      }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"a,b"');
    expect(lines[1]).toContain('"say ""yes"""');
    expect(lines[1]).toContain('"https://example.test/a?x=1,y=2"');
  });

  it("writes an empty export as just the header", () => {
    expect(exportLearningCsv([])).toBe(
      "\uFEFFword,pos,meaning,language,status,sentence,source_url",
    );
  });
});

describe("exportLearningJson", () => {
  it("round-trips through the storage parser", () => {
    const state: LearningState = emptyLearningState();
    state.words.push(word());
    state.stats = { day: localDay(NOW), todayReviewed: 2 };
    state.updatedAt = NOW;

    const parsed = parseLearningState(JSON.parse(exportLearningJson(state)));

    expect(parsed).toEqual(state);
    expect(exportLearningJson(state)).toContain('\n  "words": [');
  });
});

describe("exportFilename", () => {
  it("names the file by local day and extension", () => {
    expect(exportFilename("csv", NOW)).toBe(`ilmt-vocabulary-${localDay(NOW)}.csv`);
    expect(exportFilename("json", NOW)).toBe(`ilmt-vocabulary-${localDay(NOW)}.json`);
  });
});
