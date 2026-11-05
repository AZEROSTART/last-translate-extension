import { ProviderError } from "../shared/errors";
import { complete, listModels, streamCompletion } from "./openai";
import type { ProviderAdapter } from "./types";

export type { CompletionRequest, CompletionResult, ProviderAdapter } from "./types";
export {
  PROVIDER_TIMEOUTS,
  buildHeaders,
  complete,
  listModels,
  normalizeBaseURL,
  streamCompletion,
} from "./openai";
export { ProviderError } from "../shared/errors";

/** The adapter id exposed by `getAdapter("custom")`. */
export const ADAPTER_ID = "custom";

/**
 * Provider adapter registry. v1 has a single OpenAI-compatible kind, but the
 * background queue depends on the `ProviderAdapter` surface rather than the
 * concrete module, so more kinds can be added without touching callers.
 */
export function getAdapter(kind: "custom"): ProviderAdapter {
  if (kind !== "custom") {
    throw new ProviderError("unknown", `Unsupported provider kind: ${String(kind)}`);
  }
  return { id: ADAPTER_ID, listModels, complete, streamCompletion };
}
