import { AnthropicProvider, type Effort } from "./anthropic-provider.js";
import type { LlmProvider } from "./provider.js";
import { TestDoubleLlmProvider } from "./test-double-provider.js";

const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * Picks the provider from configuration. Unset or "test-double" = the
 * deterministic double (no network, placeholder output, clearly labelled).
 * "anthropic" = Claude; credentials come from the SDK's usual resolution
 * (ANTHROPIC_API_KEY or an `ant auth login` profile). Anything else fails
 * loudly rather than silently falling back to the double.
 */
export function createLlmProvider(config: { provider?: string; model?: string; effort?: string }): LlmProvider {
  const provider = config.provider?.trim() || "test-double";
  if (provider === "test-double") return new TestDoubleLlmProvider();
  if (provider === "anthropic") {
    const effort = config.effort?.trim();
    if (effort && !EFFORTS.has(effort as Effort)) {
      throw new Error(`LLM_EFFORT="${effort}" is not one of ${[...EFFORTS].join(", ")}`);
    }
    return new AnthropicProvider({ model: config.model?.trim() || undefined, effort: (effort as Effort) || undefined });
  }
  throw new Error(`LLM_PROVIDER="${provider}" has no adapter: use "anthropic" or "test-double"`);
}
