import type { ChatMessage, ChatUsage, ModelInfo, ProviderConfig } from "../shared/types";

/** One chat completion request. Retry/queue policy belongs to the caller. */
export interface CompletionRequest {
  /** Defaults to `ProviderConfig.model`. */
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** A non-streaming completion, with usage when the provider reports it. */
export interface CompletionResult {
  text: string;
  usage?: ChatUsage;
}

/** The adapter surface injected into the background queue (Task 7). */
export interface ProviderAdapter {
  id: string;
  listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>;
  complete(cfg: ProviderConfig, req: CompletionRequest): Promise<CompletionResult>;
  streamCompletion(cfg: ProviderConfig, req: CompletionRequest): AsyncGenerator<string>;
}
