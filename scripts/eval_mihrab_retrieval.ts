// Compares Mihrab's retrieval setups on a fixed question set.
//
//   pnpm mihrab:eval [--set scripts/mihrab_eval_set.json] [--k 10] [--misses]
//
// Scores Stage 1 (the ranked entry points) for BM25 alone, each embedder's
// vectors alone, and each embedder fused with BM25, for every embedder whose
// vectors have been built (`pnpm mihrab:seed [--embed-provider …]`).
// A gold ayah also counts as found when a Tafsir passage that explains it is
// ranked: Stage 2 brings the ayah along with its commentary.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MihrabCorpus } from "../apps/api/src/services/mihrabCorpus.js";
import { MihrabRetriever } from "../apps/api/src/services/mihrabRetriever.js";
import {
  azureEmbedder,
  azureEmbeddingSettings,
  ollamaEmbedder,
  type Embedder,
} from "../services/executor/src/mihrab-vectors.js";
import type { Lang } from "../packages/shared/src/mihrab.js";

type Item = { id: string; lang: Lang; q: string; gold: string[] };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const K = Number(flag("--k", "10"));
const set: Item[] = JSON.parse(readFileSync(resolve(root, flag("--set", "scripts/mihrab_eval_set.json")), "utf8"));

// "ayah:97:1-5" -> ayah:97:1 … ayah:97:5
const expand = (id: string) => {
  const m = /^ayah:(\d+):(\d+)-(\d+)$/.exec(id);
  if (!m) return [id];
  return Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, i) => `ayah:${m[1]}:${Number(m[2]) + i}`);
};
for (const item of set) item.gold = item.gold.flatMap(expand);

const corpus = new MihrabCorpus({ dir: resolve(root, process.env.MIHRAB_CORPUS_DIR || "data/ring1_golden_corpus") });
const allGold = [...new Set(set.flatMap((i) => i.gold))];
const known = new Set(
  (await corpus.query("SELECT node_id FROM mihrab_nodes WHERE node_id = ANY($ids)", { ids: corpus.ids(allGold) })).map(
    (r) => r.node_id as string,
  ),
);
const missing = allGold.filter((id) => !known.has(id));
if (missing.length) throw new Error(`Gold ids not in the corpus: ${missing.join(", ")}`);
// Tafsir passages that explain each gold ayah.
const explainedBy = new Map<string, string[]>();
for (const r of await corpus.query(
  "SELECT source_id, target_id FROM mihrab_edges WHERE edge_type = 'EXPLAINS_AYAH' AND target_id = ANY($ids)",
  { ids: corpus.ids(allGold.filter((id) => id.startsWith("ayah:"))) },
))
  explainedBy.set(r.target_id, [...(explainedBy.get(r.target_id) || []), r.source_id]);

const embedders: Embedder[] = [ollamaEmbedder(process.env.OLLAMA_URL || "http://127.0.0.1:11434", process.env.MIHRAB_EMBED_MODEL || undefined)];
const az = azureEmbeddingSettings(process.env);
if (az) embedders.push(azureEmbedder(az));
const usable: Embedder[] = [];
for (const e of embedders)
  if (await corpus.vectorIndex(e.id)) usable.push(e);
  else console.log(`(no vectors built for ${e.id}; skipped — pnpm mihrab:seed --embed-provider ${e.provider})`);

type Config = { name: string; retriever: MihrabRetriever; bm25: boolean; vector: boolean };
const configs: Config[] = [{ name: "BM25", retriever: new MihrabRetriever(corpus), bm25: true, vector: false }];
for (const e of usable) {
  const r = new MihrabRetriever(corpus, e);
  configs.push({ name: `vector ${e.id}`, retriever: r, bm25: false, vector: true });
  configs.push({ name: `BM25 + ${e.id}`, retriever: r, bm25: true, vector: true });
}

type Score = { item: Item; rank: number | null; recall: number; ms: number; top: string[] };
const results = new Map<string, Score[]>();
for (const c of configs) {
  const scores: Score[] = [];
  for (const item of set) {
    const t0 = Date.now();
    const r = await c.retriever.rank(item.q, { searchLang: item.lang, bm25: c.bm25, vector: c.vector });
    const top = r.candidates.slice(0, K).map((x) => x.id);
    const covers = (gold: string, id: string) => id === gold || (explainedBy.get(gold) || []).includes(id);
    const idx = top.findIndex((id) => item.gold.some((g) => covers(g, id)));
    const found = item.gold.filter((g) => top.some((id) => covers(g, id))).length;
    scores.push({ item, rank: idx < 0 ? null : idx + 1, recall: found / item.gold.length, ms: Date.now() - t0, top });
  }
  results.set(c.name, scores);
}

const pct = (n: number) => (n * 100).toFixed(0).padStart(4) + "%";
const summarize = (s: Score[]) => ({
  hit3: s.filter((x) => x.rank !== null && x.rank <= 3).length / s.length,
  hitK: s.filter((x) => x.rank !== null).length / s.length,
  mrr: s.reduce((n, x) => n + (x.rank ? 1 / x.rank : 0), 0) / s.length,
  recall: s.reduce((n, x) => n + x.recall, 0) / s.length,
  ms: s.reduce((n, x) => n + x.ms, 0) / s.length,
});
const langs: Lang[] = ["en", "de", "ar"];
console.log(`\n${set.length} questions (${langs.map((l) => `${set.filter((i) => i.lang === l).length} ${l.toUpperCase()}`).join(", ")}), top ${K}\n`);
console.log(
  "setup".padEnd(36) +
    "Hit@3  Hit@" + String(K).padEnd(3) + " MRR   Recall " +
    langs.map((l) => `Hit@${K} ${l.toUpperCase()}`.padStart(11)).join("") +
    "   ms/q",
);
for (const [name, s] of results) {
  const all = summarize(s);
  console.log(
    name.padEnd(36) +
      `${pct(all.hit3)}  ${pct(all.hitK)}  ${all.mrr.toFixed(2)}  ${pct(all.recall)}  ` +
      langs.map((l) => pct(summarize(s.filter((x) => x.item.lang === l)).hitK).padStart(11)).join("") +
      `${all.ms.toFixed(0).padStart(7)}`,
  );
}
if (process.argv.includes("--misses"))
  for (const [name, s] of results) {
    const misses = s.filter((x) => x.rank === null);
    if (!misses.length) continue;
    console.log(`\n${name} — not found in top ${K}:`);
    for (const m of misses) console.log(`  ${m.item.id.padEnd(22)} ${m.item.q}\n${" ".repeat(25)}got: ${m.top.slice(0, 5).join(", ")}`);
  }
corpus.close();
