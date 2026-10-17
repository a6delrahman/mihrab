// Embeddings for Mihrab's search chunks, written as Parquet parts under
// <corpus>/embeddings/<embedder id>/ so a run can stop and resume, and so the
// API can keep the catalog open read-only while they are written. Each
// embedder (provider, model and size) has its own folder, so indexes from
// different models can sit side by side and be compared.
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { corpusPaths, rows } from "./mihrab-catalog.js";

export const DEFAULT_EMBED_MODEL = "nomic-embed-text-v2-moe";
const lit = (v: string) => "'" + v.replaceAll("'", "''") + "'";
export const modelDir = (dir: string, id: string) =>
  resolve(corpusPaths(dir).embeddings, id.replace(/[^a-zA-Z0-9._-]+/g, "_"));
const MAX_EMBED_CHARS = 2000;

export type EmbedKind = "query" | "document";
export type Embedder = {
  // Folder name for this embedder's vectors, e.g. "nomic-embed-text-v2-moe"
  // or "azure-embedding-1024".
  id: string;
  provider: "ollama" | "azure_foundry";
  model: string;
  batch: number;
  concurrency: number;
  // Tokens billed so far (Azure reports them; Ollama does not).
  tokens: number;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<number[][]>;
};

// Nomic models are trained with task prefixes.
export const embedPrefix = (model: string, kind: EmbedKind) =>
  /nomic/i.test(model) ? `search_${kind}: ` : "";

export async function ollamaEmbed(
  url: string,
  model: string,
  input: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const r = await fetch(url.replace(/\/$/, "") + "/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, truncate: true }),
    signal,
  });
  if (!r.ok) throw new Error(`Ollama embed returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as { embeddings: number[][] };
  return data.embeddings;
}
export function ollamaEmbedder(url: string, model = DEFAULT_EMBED_MODEL): Embedder {
  return {
    id: model,
    provider: "ollama",
    model,
    batch: 32,
    concurrency: 1,
    tokens: 0,
    embed: (texts, kind, signal) =>
      ollamaEmbed(url, model, texts.map((t) => embedPrefix(model, kind) + t), signal),
  };
}

export type AzureEmbeddingSettings = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
  // text-embedding-3 models can return shorter vectors; null keeps the
  // model's full size.
  dimensions: number | null;
};
export function azureEmbeddingSettings(env: Record<string, string | undefined>): AzureEmbeddingSettings | null {
  const endpoint = env.AZURE_FOUNDRY_EMBEDDINGS_ENDPOINT?.trim().replace(/\/+$/, "");
  const apiKey = env.AZURE_FOUNDRY_EMBEDDINGS_KEY?.trim();
  const deployment = env.AZURE_FOUNDRY_EMBEDDINGS_DEPLOYMENT?.trim();
  if (!endpoint || !apiKey || !deployment) return null;
  const dims = env.AZURE_FOUNDRY_EMBEDDINGS_DIMENSIONS?.trim();
  return {
    endpoint,
    apiKey,
    deployment,
    apiVersion: env.AZURE_FOUNDRY_EMBEDDINGS_API_VERSION?.trim() || "2024-10-21",
    dimensions: dims === "full" ? null : Number(dims) || 1024,
  };
}
// The embeddings URL: the v1 API when the endpoint ends in /openai/v1,
// otherwise the deployments API on the resource.
export function azureEmbeddingsTarget(s: Pick<AzureEmbeddingSettings, "endpoint" | "deployment" | "apiVersion">) {
  const u = new URL(s.endpoint);
  if (u.protocol !== "https:") throw new Error("AZURE_FOUNDRY_EMBEDDINGS_ENDPOINT must use https://");
  return /\/openai\/v1\/?$/.test(u.pathname)
    ? { url: `${u.origin}/openai/v1/embeddings`, modelInBody: true }
    : {
        url: `${u.origin}/openai/deployments/${encodeURIComponent(s.deployment)}/embeddings?api-version=${encodeURIComponent(s.apiVersion)}`,
        modelInBody: false,
      };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function azureEmbedder(s: AzureEmbeddingSettings, http: typeof fetch = fetch): Embedder {
  const target = azureEmbeddingsTarget(s);
  const e: Embedder = {
    id: `azure-${s.deployment}-${s.dimensions ?? "full"}`,
    provider: "azure_foundry",
    model: s.deployment,
    batch: 64,
    concurrency: 4,
    tokens: 0,
    async embed(texts, _kind, signal) {
      const body = JSON.stringify({
        input: texts,
        ...(target.modelInBody ? { model: s.deployment } : {}),
        ...(s.dimensions ? { dimensions: s.dimensions } : {}),
      });
      // Rate limits and transient failures are retried, honouring Retry-After.
      for (let attempt = 0; ; attempt++) {
        const r = await http(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": s.apiKey },
          body,
          signal,
          // Never forward the key to wherever a redirect points.
          redirect: "error",
        });
        if (r.ok) {
          const data = (await r.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
          e.tokens += data.usage?.total_tokens || 0;
          return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
        }
        const text = (await r.text()).slice(0, 300);
        if ((r.status === 429 || r.status >= 500) && attempt < 6) {
          const after = Number(r.headers.get("retry-after"));
          await sleep(after > 0 ? after * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`Azure AI Foundry embeddings returned HTTP ${r.status}: ${text}`);
      }
    },
  };
  return e;
}

// MIHRAB_EMBED_PROVIDER picks the embedder: "ollama" (default) or
// "azure_foundry" (the AZURE_FOUNDRY_EMBEDDINGS_* settings).
export function embedderFromEnv(
  env: Record<string, string | undefined>,
  ollamaUrl = env.OLLAMA_URL || "http://127.0.0.1:11434",
  provider = env.MIHRAB_EMBED_PROVIDER || "ollama",
): Embedder {
  if (provider === "azure_foundry") {
    const s = azureEmbeddingSettings(env);
    if (!s)
      throw new Error(
        "MIHRAB_EMBED_PROVIDER=azure_foundry needs AZURE_FOUNDRY_EMBEDDINGS_ENDPOINT, AZURE_FOUNDRY_EMBEDDINGS_KEY and AZURE_FOUNDRY_EMBEDDINGS_DEPLOYMENT",
      );
    return azureEmbedder(s);
  }
  if (provider !== "ollama") throw new Error(`Unknown MIHRAB_EMBED_PROVIDER: ${provider}`);
  return ollamaEmbedder(ollamaUrl, env.MIHRAB_EMBED_MODEL || DEFAULT_EMBED_MODEL);
}

export type VectorMeta = { id: string; provider: string; model: string; dims: number; count: number };
export async function readVectorMeta(dir: string, id: string): Promise<VectorMeta | null> {
  const f = resolve(modelDir(dir, id), "meta.json");
  if (!existsSync(f)) return null;
  const meta = JSON.parse(await readFile(f, "utf8"));
  // Folders written before embedders had ids hold Ollama vectors.
  return { id, provider: "ollama", ...meta };
}

// English chunks only: the multilingual models place German and Arabic
// queries near them, and Arabic and German are also searched by BM25.
// Primary texts and Sharh first, so a partial run is already useful.
const ORDER = `CASE node_type WHEN 'Ayah' THEN 0 WHEN 'HadeethEncItem' THEN 1
  WHEN 'TafsirEntry' THEN 2 ELSE 3 END`;

export async function embedCorpus(opts: {
  dir: string;
  embedder: Embedder;
  partSize?: number;
  log?: (line: string) => void;
}) {
  const { embedder } = opts,
    partSize = opts.partSize || 2048,
    log = opts.log || console.log;
  const out = modelDir(opts.dir, embedder.id);
  await mkdir(out, { recursive: true });
  const mem = await DuckDBInstance.create(":memory:");
  const m = await mem.connect();
  try {
    await m.run(`ATTACH ${lit(corpusPaths(opts.dir).db)} AS ring1 (READ_ONLY)`);
    const parts = (await readdir(out)).filter((f) => /^part-\d+\.parquet$/.test(f)).sort();
    const done = new Set<string>(
      parts.length
        ? (await rows(m, `SELECT chunk_key FROM read_parquet(${lit(out + "/part-*.parquet")})`)).map(
            (r) => r.chunk_key,
          )
        : [],
    );
    const todo = (
      await rows(
        m,
        `SELECT chunk_key, node_id, text FROM ring1.mihrab_chunks WHERE lang = 'en' ORDER BY ${ORDER}, chunk_id`,
      )
    ).filter((r) => !done.has(r.chunk_key));
    await m.run("DETACH ring1");
    log(`  ${done.size.toLocaleString("en-US")} chunks already embedded, ${todo.length.toLocaleString("en-US")} to go (${embedder.id})`);
    let next = parts.length,
      logged = 0,
      dims = 0,
      pending: { chunk_key: string; node_id: string; vec: number[] }[] = [];
    const started = Date.now();
    const flush = async () => {
      if (!pending.length) return;
      const name = `part-${String(next++).padStart(4, "0")}`;
      const json = resolve(out, name + ".jsonl.tmp");
      await writeFile(json, pending.map((p) => JSON.stringify(p)).join("\n"));
      await m.run(
        `COPY (SELECT chunk_key, node_id, vec::FLOAT[${dims}] AS vec FROM read_json(${lit(json)},
           columns = {chunk_key: 'VARCHAR', node_id: 'VARCHAR', vec: 'FLOAT[]'}))
         TO ${lit(resolve(out, name + ".parquet"))} (FORMAT parquet, COMPRESSION zstd)`,
      );
      await rm(json);
      pending = [];
    };
    // A round is `concurrency` batches sent at once.
    const round = embedder.batch * embedder.concurrency;
    for (let i = 0; i < todo.length; i += round) {
      const slices = [];
      for (let j = i; j < Math.min(i + round, todo.length); j += embedder.batch)
        slices.push(todo.slice(j, j + embedder.batch));
      const results = await Promise.all(
        slices.map((slice) => embedder.embed(slice.map((r) => String(r.text).slice(0, MAX_EMBED_CHARS)), "document")),
      );
      slices.forEach((slice, s) => {
        dims ||= results[s][0].length;
        slice.forEach((r, j) => pending.push({ chunk_key: r.chunk_key, node_id: r.node_id, vec: results[s][j] }));
      });
      if (pending.length >= partSize) await flush();
      const n = Math.min(i + round, todo.length);
      if (n - logged >= 640 || n === todo.length) {
        logged = n;
        const rate = n / ((Date.now() - started) / 1000);
        log(
          `  embedded ${n.toLocaleString("en-US")}/${todo.length.toLocaleString("en-US")} (${rate.toFixed(0)}/s, ~${Math.ceil((todo.length - n) / rate / 60)} min left${embedder.tokens ? `, ${embedder.tokens.toLocaleString("en-US")} tokens` : ""})`,
        );
      }
    }
    await flush();
    const anyParts = (await readdir(out)).some((f) => /^part-\d+\.parquet$/.test(f));
    if (!anyParts) return { id: embedder.id, provider: embedder.provider, model: embedder.model, dims: 0, count: 0 };
    const [stats] = await rows(
      m,
      `SELECT count(*) AS n, any_value(len(vec)) AS d FROM read_parquet(${lit(out + "/part-*.parquet")})`,
    );
    const meta: VectorMeta = {
      id: embedder.id,
      provider: embedder.provider,
      model: embedder.model,
      dims: Number(stats.d),
      count: Number(stats.n),
    };
    await writeFile(resolve(out, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  } finally {
    m.closeSync();
    mem.closeSync();
  }
}
