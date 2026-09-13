import type { LLMProvider, CompleteParams, ProviderResult } from "./provider.js";
import { BedrockProvider, BedrockError, isBedrockConfigured } from "./provider.js";
import { LocalProvider } from "./localProvider.js";
import { config } from "../config/env.js";

/**
 * Auto provider: uses Amazon Bedrock when credentials are configured, and
 * degrades to the deterministic local router otherwise. The effective
 * provider is reported back per completion so the UI can surface which
 * engine handled a request.
 */
export class AutoProvider implements LLMProvider {
  readonly id = "auto";
  private bedrock: BedrockProvider | null = isBedrockConfigured() ? new BedrockProvider() : null;

  get model(): string {
    return this.bedrock?.model ?? "hearth-intent-router/v1";
  }

  async complete(params: CompleteParams): Promise<ProviderResult> {
    if (this.bedrock) {
      try {
        return await this.bedrock.complete(params);
      } catch (err) {
        if (err instanceof BedrockError) {
          return this.local().complete(params);
        }
        throw err;
      }
    }
    return this.local().complete(params);
  }

  private local(): LocalProvider {
    return new LocalProvider();
  }
}

export function buildProvider(): LLMProvider {
  switch (config.llmProvider) {
    case "bedrock":
      return new BedrockProvider();
    case "local":
      return new LocalProvider();
    default:
      return new AutoProvider();
  }
}

export function buildAutoProvider(): LLMProvider {
  return buildProvider();
}