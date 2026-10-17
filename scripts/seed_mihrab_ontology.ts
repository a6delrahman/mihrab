// Seeds Mihrab's Ring 1 knowledge base.
//
//   pnpm mihrab:seed                 corpus (if missing) + catalog + embeddings
//   pnpm mihrab:seed --rebuild       re-fetch the corpus first (--full: every HadeethEnc item)
//   pnpm mihrab:seed --no-embed      skip embeddings (BM25-only retrieval)
//   pnpm mihrab:seed --embed-provider azure_foundry   embed with Azure (default: MIHRAB_EMBED_PROVIDER, else ollama)
//   pnpm mihrab:seed --rebuild-catalog  rebuild the DuckDB catalog even if it is current
//   pnpm mihrab:seed --foundry       also register Ring 1 in a Helix Foundry workspace
//                                    (HelixDB ontology); needs the app running
//
// 1. Runs scripts/ingest_ring1.py when data/ring1_golden_corpus/ring1_knowledge.duckdb
//    does not exist yet.
// 2. Registers the corpus tables, the ontology and per-language BM25 indexes
//    in that DuckDB file, and checks that the five core tables are queryable.
// 3. Embeds the English search chunks with Ollama (resumable).
// 4. Optionally uploads the node and edge tables to Helix Foundry and imports
//    the Ring 1 object types and relationships as a proposal to publish.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  buildCatalog,
  catalogCurrent,
  corpusPaths,
  rows,
} from "../services/executor/src/mihrab-catalog.js";
import {
  embedCorpus,
  embedderFromEnv,
} from "../services/executor/src/mihrab-vectors.js";
import { CORE_TABLES } from "../packages/shared/src/mihrab.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, process.env.MIHRAB_CORPUS_DIR || "data/ring1_golden_corpus");
const args = new Set(process.argv.slice(2));
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ollama = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const paths = corpusPaths(dir);

function python() {
  const venv = resolve(root, ".venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

console.log("🕌 Mihrab — seeding the Ring 1 ontology\n");
if (args.has("--rebuild") || !existsSync(paths.db)) {
  console.log(`[1/4] Building the golden corpus with ${python()} scripts/ingest_ring1.py …`);
  const r = spawnSync(
    python(),
    ["-I", resolve(root, "scripts/ingest_ring1.py"), ...(args.has("--full") ? ["--full"] : [])],
    { stdio: "inherit", cwd: root, env: { ...process.env, MIHRAB_CORPUS_DIR: dir } },
  );
  if (r.status !== 0) {
    console.error("The corpus builder failed; see its output above.");
    process.exit(1);
  }
} else console.log(`[1/4] Golden corpus found: ${paths.db}`);

console.log("\n[2/4] Registering tables, ontology and BM25 indexes in DuckDB …");
if (!args.has("--rebuild") && !args.has("--rebuild-catalog") && (await catalogCurrent(dir)))
  console.log("  catalog is current (newer than every Parquet table); --rebuild-catalog forces a rebuild");
else {
  const report = await buildCatalog(dir).catch((e: Error) => {
    if (/lock/i.test(e.message))
      throw new Error("The corpus is open in the running app. Stop `pnpm dev` (or the app container), then run this again.");
    throw e;
  });
  const dangling = report.danglingEdges.filter((d) => d.count);
  console.log(
    dangling.length
      ? `  ⚠️ edges with a missing endpoint: ${dangling.map((d) => `${d.edge_type} ${d.side} ×${d.count}`).join(", ")}`
      : "  ✓ every edge resolves to a node on both sides",
  );
  if (report.ayahsWithoutTafsir.length)
    console.log(
      `  ℹ ${report.ayahsWithoutTafsir.length} ayahs have no Tafsir node in this edition: ${report.ayahsWithoutTafsir.join(", ")}`,
    );
}

// Verify the five core tables through a fresh read-only connection, the
// way the API reads them.
{
  const db = await DuckDBInstance.create(paths.db, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  for (const t of CORE_TABLES) {
    const [r] = await rows(c, `SELECT count(*) AS n, any_value(node_id) AS sample FROM ${
      t === "graph_edges" ? "(SELECT source_id AS node_id FROM graph_edges)" : t
    }`);
    console.log(`  ✓ ${t.padEnd(18)} queryable: ${Number(r.n).toLocaleString("en-US").padStart(8)} rows (e.g. ${r.sample})`);
  }
  c.closeSync();
  db.closeSync();
}

const embedder = embedderFromEnv(process.env, ollama, flag("--embed-provider"));
console.log(`\n[3/4] Embeddings (${embedder.id}, ${embedder.provider}) …`);
if (args.has("--no-embed")) console.log("  skipped (--no-embed): retrieval will use BM25 only");
else if (embedder.provider === "ollama") {
  const tags = await fetch(ollama + "/api/tags", { signal: AbortSignal.timeout(4000) })
    .then((r) => r.json() as Promise<{ models: { name: string }[] }>)
    .catch(() => null);
  const installed = tags?.models.some((m) => m.name === embedder.model || m.name === embedder.model + ":latest");
  if (!tags) console.log("  skipped: Ollama is not reachable; retrieval will use BM25 only until you re-run this");
  else if (!installed)
    console.log(`  skipped: run \`ollama pull ${embedder.model}\` first; retrieval will use BM25 only until then`);
  else {
    const meta = await embedCorpus({ dir, embedder });
    console.log(`  ✓ ${meta.count.toLocaleString("en-US")} vectors × ${meta.dims} dims`);
  }
} else {
  const meta = await embedCorpus({ dir, embedder });
  console.log(
    `  ✓ ${meta.count.toLocaleString("en-US")} vectors × ${meta.dims} dims${embedder.tokens ? ` (${embedder.tokens.toLocaleString("en-US")} tokens billed this run)` : ""}`,
  );
}

console.log("\n[4/4] Helix Foundry / HelixDB ontology …");
if (!args.has("--foundry")) console.log("  skipped (pass --foundry with the app running to register Ring 1 in HelixDB)");
else {
  const { registerInFoundry } = await import("../apps/api/src/services/mihrabFoundry.js");
  await registerInFoundry({
    dir,
    base: flag("--api") || process.env.MIHRAB_FOUNDRY_API || "http://127.0.0.1:3001",
    origin: process.env.APP_ORIGIN || "http://localhost:5173",
    publish: args.has("--publish"),
    log: console.log,
  });
}
console.log("\nDone. Start the app with `pnpm dev` and open http://localhost:5173/mihrab");
