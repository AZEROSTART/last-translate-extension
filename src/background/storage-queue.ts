import { getLearning, saveLearning } from "../shared/learning-storage";
import type { LearningState } from "../shared/types";

/**
 * Every learning write goes through one promise chain. Two tabs capturing the
 * same word, or a burst of reviews, must never read-modify-write the same
 * snapshot and drop an update.
 */
let chain: Promise<unknown> = Promise.resolve();

export function runLearningUpdate<T>(
  fn: (state: LearningState) => { state: LearningState; result: T },
): Promise<T> {
  const run = chain.then(async () => {
    const state = await getLearning();
    const next = fn(state);
    await saveLearning(next.state);
    return next.result;
  });
  // A failed task must not poison the queue for every later write.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
