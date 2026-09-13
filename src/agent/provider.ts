import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import { config } from "../config/env.js";

export interface JsonTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultMessage {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ModelToolCall[];
  toolResults?: ToolResultMessage[];
}

export interface CompleteParams {
  system: string;
  messages: ProviderMessage[];
  tools: JsonTool[];
}

export interface ProviderResult {
  text: string | null;
  toolCalls: ModelToolCall[];
  provider: string;
  model: string;
  stopReason?: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  complete(params: CompleteParams): Promise<ProviderResult>;
}

export class BedrockError extends Error {}

/**
 * Amazon Bedrock provider using the Converse API.
 * Default model `us.anthropic.claude-haiku-4-5-20251001-v1:0` (inference profile form,
 * on-demand pricing, available in us-east-1) — override with HEARTH_BEDROCK_MODEL.
 * @aws-service bedrock-runtime
 */
export class BedrockProvider implements LLMProvider {
  readonly id = "bedrock";
  readonly model: string;
  private client: BedrockRuntimeClient;

  constructor(model: string = config.bedrockModel, region: string = config.bedrockRegion) {
    this.model = model;
    this.client = new BedrockRuntimeClient({ region });
  }

  async complete(params: CompleteParams): Promise<ProviderResult> {
    try {
      const toolConfig = params.tools.length
        ? ({
            tools: params.tools.map((t) => ({
              toolSpec: {
                name: t.name,
                description: t.description,
                inputSchema: { json: t.schema as never },
              },
            })),
            toolChoice: { auto: {} },
          } as unknown as ToolConfiguration)
        : undefined;
      const command = new ConverseCommand({
        modelId: this.model,
        system: [{ text: params.system }],
        messages: toConverseMessages(params.messages),
        toolConfig,
        inferenceConfig: { maxTokens: 1024, temperature: 0.4 },
      });
      const response = await this.client.send(command);
      const blocks = response.output?.message?.content ?? [];

      const text = blocks
        .map((b) => b.text)
        .filter((t): t is string => typeof t === "string")
        .join("");
      const toolCalls = blocks.flatMap((b) =>
        b.toolUse
          ? [{ id: b.toolUse.toolUseId ?? crypto.randomUUID(), name: b.toolUse.name ?? "", input: (b.toolUse.input ?? {}) as Record<string, unknown> }]
          : [],
      );
      return {
        text: text.length ? text : null,
        toolCalls,
        provider: this.id,
        model: this.model,
        stopReason: response.stopReason,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BedrockError(`Bedrock invocation failed (${this.model}): ${message}`);
    }
  }
}

function toConverseMessages(messages: ProviderMessage[]): { role: "user" | "assistant"; content: ContentBlock[] }[] {
  const out: { role: "user" | "assistant"; content: ContentBlock[] }[] = [];
  for (const m of messages) {
    const content: ContentBlock[] = [];
    if (m.role === "assistant") {
      if (m.content) content.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.input as never } });
      }
    } else {
      if (m.toolResults && m.toolResults.length) {
        for (const r of m.toolResults) {
          content.push({
            toolResult: {
              toolUseId: r.toolUseId,
              content: [{ text: r.content }],
              status: r.isError ? "error" : "success",
            },
          });
        }
      }
      if (m.content) content.push({ text: m.content });
    }
    out.push({ role: m.role, content });
  }
  return out;
}

/** Strip keywords Bedrock's Converse schema validator may reject and keep a minimal draft-safe subset. */
const KEEP = new Set(["type", "description", "enum", "const", "required", "properties", "items", "additionalProperties", "enumDescriptions"]);

export function toBedrockToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (!KEEP.has(k)) continue;
        out[k] = clean(v);
      }
      return out;
    }
    return node;
  };
  return clean(schema) as Record<string, unknown>;
}

export function isBedrockConfigured(): boolean {
  const creds = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_SECRET_ACCESS_KEY;
  return Boolean(creds);
}