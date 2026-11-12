import {
  applyReviewAnswer,
  getLearning,
  mergeLearnedWord,
} from "../shared/learning-storage";
import { formatDueLabel } from "../shared/srs";
import type {
  LearnWordMessage,
  LearnWordResponse,
  ReviewAnswerMessage,
  ReviewAnswerResponse,
} from "../shared/types";
import { runLearningUpdate } from "./storage-queue";

const LEARNING_TYPES = new Set(["learn-word", "review-answer", "get-learning", "lookup-gloss"]);

export function isLearningMessageType(type: unknown): boolean {
  return typeof type === "string" && LEARNING_TYPES.has(type);
}

/**
 * Handle one learning runtime message. Writes are serialized; reads may race.
 * Unknown types return null so the caller can fall through to other handlers.
 */
export async function handleLearningMessage(message: unknown): Promise<unknown> {
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
        dueAt: merged.word.dueAt,
        nextDueLabel: formatDueLabel(merged.word.dueAt, now),
      };
      return response;
    }
    case "review-answer": {
      const input = msg as ReviewAnswerMessage;
      const now = Date.now();
      const word = await runLearningUpdate((state) => {
        const next = applyReviewAnswer(state, input, now);
        return { state: next.state, result: next.word };
      });
      if (!word) return { ok: false };
      const response: ReviewAnswerResponse = { ok: true, word };
      return response;
    }
    case "get-learning":
      return { ok: true, state: await getLearning() };
    case "lookup-gloss":
      return { ok: false, reason: "not-implemented" };
    default:
      return null;
  }
}
