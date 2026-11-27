import {
  applyReviewAnswer,
  deleteWord,
  getLearning,
  mergeLearnedWord,
  undoReviewAnswer,
} from "../shared/learning-storage";
import { formatDueLabel } from "../shared/srs";
import type {
  DeleteWordMessage,
  DeleteWordResponse,
  LearnWordMessage,
  LearnWordResponse,
  MnemonicMessage,
  ReviewAnswerMessage,
  ReviewAnswerResponse,
  ReviewUndoMessage,
  ReviewUndoResponse,
} from "../shared/types";
import { createMnemonicDeps, generateMnemonic } from "./mnemonic";
import type { RequestQueue } from "./queue";
import { runLearningUpdate } from "./storage-queue";
import { refreshBadge } from "./badge";

export interface LearningDeps {
  /** Shared scheduler; keeps mnemonic work behind the same global caps. */
  queue?: RequestQueue;
}

const LEARNING_TYPES = new Set([
  "learn-word",
  "delete-word",
  "review-answer",
  "review-undo",
  "get-learning",
  "lookup-gloss",
  "mnemonic",
]);

export function isLearningMessageType(type: unknown): boolean {
  return typeof type === "string" && LEARNING_TYPES.has(type);
}

/**
 * Handle one learning runtime message. Writes are serialized; reads may race.
 * Unknown types return null so the caller can fall through to other handlers.
 */
export async function handleLearningMessage(
  message: unknown,
  deps: LearningDeps = {},
): Promise<unknown> {
  if (!message || typeof message !== "object") return null;
  const msg = message as { type?: unknown };

  switch (msg.type) {
    case "learn-word": {
      const input = msg as LearnWordMessage;
      const now = Date.now();
      const merged = await runLearningUpdate((state) => {
        const next = mergeLearnedWord(state, input, now);
        return { state: next.state, result: next };
      });
      const response: LearnWordResponse = {
        ok: true,
        created: merged.created,
        id: merged.word.id,
        dueAt: merged.word.dueAt,
        nextDueLabel: formatDueLabel(merged.word.dueAt, now),
      };
      void refreshBadge();
      return response;
    }
    case "delete-word": {
      const input = msg as DeleteWordMessage;
      if (typeof input.id !== "string" || input.id.length === 0) {
        return { ok: false } satisfies DeleteWordResponse;
      }
      const now = Date.now();
      const result = await runLearningUpdate((state) => {
        const next = deleteWord(state, input.id, now);
        return { state: next.state, result: next };
      });
      if (!result.deleted) return { ok: false } satisfies DeleteWordResponse;
      void refreshBadge();
      return { ok: true } satisfies DeleteWordResponse;
    }
    case "review-answer": {
      const input = msg as ReviewAnswerMessage;
      const now = Date.now();
      const answered = await runLearningUpdate((state) => {
        const next = applyReviewAnswer(state, input, now);
        return { state: next.state, result: { word: next.word, stats: next.state.stats } };
      });
      if (!answered.word) return { ok: false };
      const response: ReviewAnswerResponse = {
        ok: true,
        word: answered.word,
        stats: answered.stats,
      };
      void refreshBadge();
      return response;
    }
    case "review-undo": {
      const input = msg as ReviewUndoMessage;
      const now = Date.now();
      const undone = await runLearningUpdate((state) => {
        const next = undoReviewAnswer(state, input, now);
        return { state: next.state, result: next };
      });
      if (!undone.word) {
        const response: ReviewUndoResponse = { ok: false, reason: undone.reason };
        return response;
      }
      const response: ReviewUndoResponse = { ok: true, word: undone.word };
      void refreshBadge();
      return response;
    }
    case "get-learning":
      return { ok: true, state: await getLearning() };
    case "lookup-gloss":
      return { ok: false, reason: "not-implemented" };
    case "mnemonic": {
      const input = msg as MnemonicMessage;
      if (typeof input.id !== "string" || input.id.length === 0) {
        return { ok: false, reason: "unknown-word" };
      }
      return generateMnemonic(
        input.id,
        createMnemonicDeps(deps.queue ? { queue: deps.queue } : {}),
      );
    }
    default:
      return null;
  }
}
