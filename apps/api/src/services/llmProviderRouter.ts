// Mihrab's LLM router: Azure AI Foundry deployments and local Ollama models
// behind one streaming interface, so the same grounded context can be sent
// to either and the answers compared.
import type {
  LlmCatalog,
  LlmModel,
  ProviderId,
} from "../../../../packages/shared/src/mihrab.js";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import { azureBase } from "../providers.js";
import { AppError } from "../security.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type StreamPart =
  | { type: "token"; text: string }
  // Reasoning a model does before answering; never shown or kept.
  | { type: "thinking" }
  | { type: "usage"; promptTokens: number | null; completionTokens: number | null };
type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export type AzureSettings = {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployments: string[];
};
export function azureSettings(env: Env): AzureSettings | null {
  const endpoint = env.AZURE_FOUNDRY_ENDPOINT?.trim().replace(/\/+$/, "");
  const apiKey = env.AZURE_FOUNDRY_API_KEY?.trim();
  const deployments = (env.AZURE_FOUNDRY_DEPLOYMENTS || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (!endpoint || !apiKey || !deployments.length) return null;
  return {
    endpoint,
    apiKey,
    apiVersion: env.AZURE_FOUNDRY_API_VERSION?.trim() || "2024-10-21",
    deployments,
  };
}
// Claude deployments on Azure AI Foundry speak Anthropic's Messages API;
// every other deployment speaks OpenAI chat completions.
export const isClaudeDeployment = (deployment: string) => /claude/i.test(deployment);
// The Foundry SDK's base URL, https://RESOURCE.services.ai.azure.com/anthropic/,
// from the resource endpoint or its …/anthropic/v1/messages URL.
export function azureAnthropicBase(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new AppError(400, "AZURE_FOUNDRY_ENDPOINT must use https://");
  return `${url.origin}/anthropic/`;
}
// The chat completions URL and whether the deployment goes in the body:
// - …/openai/v1 or AZURE_FOUNDRY_API_VERSION=v1: OpenAI v1 API, model in body
// - …services.ai.azure.com/models: Foundry Models inference, model in body
// - otherwise (including an …/anthropic endpoint): Azure OpenAI deployments
//   path on the resource, with ?api-version
export function azureChatTarget(s: Pick<AzureSettings, "endpoint" | "apiVersion">, deployment: string) {
  const url = new URL(s.endpoint);
  if (url.protocol !== "https:") throw new AppError(400, "AZURE_FOUNDRY_ENDPOINT must use https://");
  if (/\/anthropic(\/|$)/.test(url.pathname))
    return {
      url: `${url.origin}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(s.apiVersion)}`,
      modelInBody: false,
    };
  if (s.apiVersion === "v1" || /\/openai\/v1$/.test(url.pathname))
    return { url: azureBase(s.endpoint) + "/chat/completions", modelInBody: true };
  if (/\/models$/.test(url.pathname))
    return {
      url: `${s.endpoint}/chat/completions?api-version=${encodeURIComponent(s.apiVersion)}`,
      modelInBody: true,
    };
  return {
    url: `${url.origin}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(s.apiVersion)}`,
    modelInBody: false,
  };
}

// Reasoning models (DeepSeek-R1, Qwen3) may stream <think>…</think> before
// the answer. Only the answer is shown and kept.
export class ThinkFilter {
  private buf = "";
  private inThink = false;
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf("</think>");
        if (end < 0) {
          this.buf = this.buf.slice(-7);
          return out;
        }
        this.buf = this.buf.slice(end + 8);
        this.inThink = false;
      } else {
        const start = this.buf.indexOf("<think>");
        if (start >= 0) {
          out += this.buf.slice(0, start);
          this.buf = this.buf.slice(start + 7);
          this.inThink = true;
          continue;
        }
        // Hold back an end that could be the start of "<think>".
        let keep = 0;
        for (let k = Math.min(6, this.buf.length); k > 0 && !keep; k--)
          if ("<think>".startsWith(this.buf.slice(-k))) keep = k;
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
    }
  }
  flush() {
    const rest = this.inThink ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

async function* lines(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) yield buf;
}
async function errorText(r: Response) {
  const text = await r.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    return String(j.error?.message || j.error || j.message || text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export type ClaudeClient = Pick<AnthropicFoundry, "messages">;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export class LLMProviderRouter {
  constructor(
    private env: Env = process.env,
    private ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    private http: Fetch = fetch,
    private claudeClient: (baseURL: string, apiKey: string) => ClaudeClient = (baseURL, apiKey) =>
      new AnthropicFoundry({ baseURL, apiKey }),
  ) {}
  get azure() {
    return azureSettings(this.env);
  }

  async ollamaModels(): Promise<{ models: (LlmModel & { thinking: boolean })[]; error?: string }> {
    try {
      const r = await this.http(this.ollamaUrl.replace(/\/$/, "") + "/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return { models: [], error: `Ollama returned HTTP ${r.status}` };
      const data = (await r.json()) as {
        models: { name: string; details?: { parameter_size?: string }; capabilities?: string[] }[];
      };
      const models = data.models
        .filter((m) =>
          m.capabilities ? m.capabilities.includes("completion") : !/embed|minilm/i.test(m.name),
        )
        .map((m) => ({
          provider: "ollama" as const,
          id: m.name,
          label: m.name.replace(/:latest$/, ""),
          detail: [m.details?.parameter_size, m.name.endsWith(":cloud") ? "Ollama cloud" : "local"]
            .filter(Boolean)
            .join(" · "),
          thinking: !!m.capabilities?.includes("thinking"),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return { models };
    } catch {
      return { models: [], error: `Ollama is not reachable at ${this.ollamaUrl}` };
    }
  }

  async listModels(): Promise<LlmCatalog> {
    const az = this.azure;
    const ol = await this.ollamaModels();
    const azureModels: LlmModel[] = (az?.deployments || []).map((d) => ({
      provider: "azure_foundry",
      id: d,
      label: d,
      detail: isClaudeDeployment(d) ? "Claude · Azure AI Foundry" : "Azure AI Foundry deployment",
    }));
    const ollamaModels: LlmModel[] = ol.models.map(({ thinking: _, ...m }) => m);
    const want = {
      provider: this.env.MIHRAB_DEFAULT_PROVIDER as ProviderId | undefined,
      model: this.env.MIHRAB_DEFAULT_MODEL,
    };
    const all = [...azureModels, ...ollamaModels];
    const pick =
      all.find((m) => m.provider === want.provider && (!want.model || m.id === want.model)) ||
      azureModels[0] ||
      ollamaModels.find((m) => m.id === "qwen3:4b") ||
      ollamaModels.find((m) => !m.id.endsWith(":cloud")) ||
      ollamaModels[0];
    return {
      providers: [
        {
          id: "azure_foundry",
          label: "Azure AI Foundry",
          available: !!az,
          reason: az
            ? undefined
            : "Set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY and AZURE_FOUNDRY_DEPLOYMENTS in .env",
          models: azureModels,
        },
        {
          id: "ollama",
          label: "Local Ollama",
          available: !ol.error && ollamaModels.length > 0,
          reason: ol.error || (ollamaModels.length ? undefined : "No chat models installed (ollama pull qwen3:4b)"),
          models: ollamaModels,
        },
      ],
      default: pick ? { provider: pick.provider, model: pick.id } : null,
    };
  }

  // Checked before a stream opens, so a bad choice is a plain 400.
  async validate(provider: ProviderId, model: string) {
    if (provider === "azure_foundry") {
      const az = this.azure;
      if (!az) throw new AppError(400, "Azure AI Foundry is not configured on this server");
      if (!az.deployments.includes(model))
        throw new AppError(400, `Unknown Azure AI Foundry deployment: ${model}`);
      return;
    }
    const { models, error } = await this.ollamaModels();
    if (error) throw new AppError(503, error);
    if (!models.some((m) => m.id === model))
      throw new AppError(400, `Model ${model} is not installed in Ollama`);
  }

  async *stream(opts: {
    provider: ProviderId;
    model: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    maxTokens?: number;
  }): AsyncGenerator<StreamPart> {
    const think = new ThinkFilter();
    const source = opts.provider === "azure_foundry" ? this.streamAzure(opts) : this.streamOllama(opts);
    for await (const part of source) {
      if (part.type === "token") {
        const text = think.push(part.text);
        if (text) yield { type: "token", text };
      } else yield part;
    }
    const rest = think.flush();
    if (rest) yield { type: "token", text: rest };
  }

  private async *streamAzure(opts: {
    model: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    maxTokens?: number;
  }): AsyncGenerator<StreamPart> {
    const az = this.azure;
    if (!az) throw new AppError(400, "Azure AI Foundry is not configured on this server");
    if (!az.deployments.includes(opts.model))
      throw new AppError(400, `Unknown Azure AI Foundry deployment: ${opts.model}`);
    if (isClaudeDeployment(opts.model)) {
      yield* this.streamClaude(az, opts);
      return;
    }
    const target = azureChatTarget(az, opts.model);
    const body: Record<string, unknown> = {
      ...(target.modelInBody ? { model: opts.model } : {}),
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: opts.maxTokens || 1800,
    };
    const send = (b: Record<string, unknown>) =>
      this.http(target.url, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": az.apiKey },
        body: JSON.stringify(b),
        signal: opts.signal,
        // Never forward the key to wherever a redirect points.
        redirect: "error",
      });
    let r = await send(body);
    if (r.status === 400) {
      // Reasoning deployments (o-series, gpt-5) refuse temperature and
      // max_tokens; retry once with the parameters they take.
      const msg = await errorText(r);
      if (!/max_tokens|temperature|unsupported/i.test(msg))
        throw new AppError(502, `Azure AI Foundry returned HTTP 400: ${msg}`);
      const { temperature: _t, max_tokens, ...rest } = body;
      r = await send({ ...rest, max_completion_tokens: max_tokens });
    }
    if (!r.ok || !r.body)
      throw new AppError(502, `Azure AI Foundry returned HTTP ${r.status}: ${await errorText(r)}`);
    for await (const line of lines(r.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw new AppError(502, `Azure AI Foundry: ${j.error.message || "stream error"}`);
      const delta = j.choices?.[0]?.delta;
      if (delta?.reasoning_content) yield { type: "thinking" };
      if (delta?.content) yield { type: "token", text: delta.content };
      if (j.usage)
        yield {
          type: "usage",
          promptTokens: j.usage.prompt_tokens ?? null,
          completionTokens: j.usage.completion_tokens ?? null,
        };
    }
  }

  // Claude on Azure AI Foundry, through Anthropic's Foundry SDK.
  private async *streamClaude(
    az: AzureSettings,
    opts: { model: string; messages: ChatMessage[]; signal?: AbortSignal },
  ): AsyncGenerator<StreamPart> {
    const client = this.claudeClient(azureAnthropicBase(az.endpoint), az.apiKey);
    const system = opts.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages: Anthropic.MessageParam[] = opts.messages
      .filter((m) => m.role !== "system" && m.content.trim())
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const effort = EFFORTS.find((e) => e === this.env.MIHRAB_CLAUDE_EFFORT?.trim());
    try {
      const stream = client.messages.stream(
        {
          model: opts.model,
          // Thinking counts toward max_tokens; the prompt sets the answer's length.
          max_tokens: 16000,
          // The system prompt is the stable prefix, so it is the one to cache.
          ...(system ? { system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }] } : {}),
          thinking: { type: "adaptive" },
          ...(effort ? { output_config: { effort } } : {}),
          messages,
        },
        { signal: opts.signal },
      );
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "thinking") yield { type: "thinking" };
        else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") yield { type: "token", text: event.delta.text };
          else if (event.delta.type === "thinking_delta") yield { type: "thinking" };
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal")
        throw new AppError(422, "Claude declined this request. Rephrase it, or choose another model.");
      const u = final.usage;
      yield {
        type: "usage",
        promptTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        completionTokens: u.output_tokens,
      };
    } catch (e) {
      if (e instanceof AppError || e instanceof Anthropic.APIUserAbortError) throw e;
      if (e instanceof Anthropic.APIError)
        throw new AppError(502, `Azure AI Foundry (Claude) returned ${e.status ? "HTTP " + e.status : "an error"}: ${e.message.slice(0, 300)}`);
      throw e;
    }
  }

  private async *streamOllama(opts: {
    model: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    maxTokens?: number;
  }): AsyncGenerator<StreamPart> {
    const { models, error } = await this.ollamaModels();
    if (error) throw new AppError(503, error);
    const m = models.find((x) => x.id === opts.model);
    if (!m) throw new AppError(400, `Model ${opts.model} is not installed in Ollama`);
    // Size the context window to the prompt (~3.5 characters per token) plus
    // room for the answer, so the grounded context is never silently cut.
    const chars = opts.messages.reduce((n, x) => n + x.content.length, 0);
    const need = Math.ceil(chars / 3.5) + (opts.maxTokens || 1800) + (m.thinking ? 4096 : 0) + 512;
    const numCtx = [8192, 16384, 32768, 65536].find((n) => n >= need) || 65536;
    const r = await this.http(this.ollamaUrl.replace(/\/$/, "") + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        // Some thinking models (qwen3:4b among them) reason even with
        // think:false and then send the reasoning as answer text. Asking for
        // it keeps it in message.thinking, apart from the answer.
        ...(m.thinking ? { think: true } : {}),
        keep_alive: process.env.MODEL_KEEP_ALIVE || "5m",
        options: {
          temperature: 0.2,
          num_ctx: numCtx,
          num_predict: (opts.maxTokens || 1800) + (m.thinking ? 4096 : 0),
        },
      }),
      signal: opts.signal,
    });
    if (!r.ok || !r.body) throw new AppError(502, `Ollama returned HTTP ${r.status}: ${await errorText(r)}`);
    for await (const line of lines(r.body)) {
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      if (j.error) throw new AppError(502, "Ollama: " + j.error);
      if (j.message?.thinking) yield { type: "thinking" };
      if (j.message?.content) yield { type: "token", text: j.message.content };
      if (j.done)
        yield {
          type: "usage",
          promptTokens: j.prompt_eval_count ?? null,
          completionTokens: j.eval_count ?? null,
        };
    }
  }
}
