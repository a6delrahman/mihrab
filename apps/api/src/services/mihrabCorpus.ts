// Read-only access to Mihrab's Ring 1 catalog. An in-memory DuckDB holds the
// chunk embeddings; the catalog file is attached read-only, so the corpus
// cannot be changed through the API.
import {
  DuckDBInstance,
  listValue,
  type DuckDBConnection,
} from "@duckdb/node-api";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { corpusPaths } from "../../../../services/executor/src/mihrab-catalog.js";
import {
  modelDir,
  readVectorMeta,
  type VectorMeta,
} from "../../../../services/executor/src/mihrab-vectors.js";
import { AppError } from "../security.js";

const lit = (v: string) => "'" + v.replaceAll("'", "''") + "'";
export type Row = Record<string, any>;
// DuckDB BIGINTs arrive as BigInt, which JSON cannot carry. Ring 1's
// integers (surah, ayah and hadith numbers) are all far below 2^53.
const plain = (v: any): any =>
  typeof v === "bigint"
    ? Number(v)
    : Array.isArray(v)
      ? v.map(plain)
      : v && typeof v === "object" && !(v instanceof Date)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
        : v;

export type VectorIndex = VectorMeta & { table: string };

export class MihrabCorpus {
  readonly dir: string;
  // The embedder whose vectors status() reports (the one answers use).
  readonly embedderId: string | null;
  private opening?: Promise<DuckDBInstance>;
  private vectors = new Map<string, { index: VectorIndex | null; checkedAt: number; stamp: number }>();
  constructor(opts: { dir?: string; embedderId?: string | null } = {}) {
    this.dir = resolve(opts.dir || process.env.MIHRAB_CORPUS_DIR || "data/ring1_golden_corpus");
    this.embedderId = opts.embedderId ?? null;
  }
  get available() {
    return existsSync(corpusPaths(this.dir).db);
  }

  private instance() {
    this.opening ??= (async () => {
      const db = corpusPaths(this.dir).db;
      if (!existsSync(db))
        throw new AppError(503, "The Ring 1 corpus is not built yet. Run `pnpm mihrab:seed`.");
      const instance = await DuckDBInstance.create(":memory:");
      const c = await instance.connect();
      try {
        await c.run("INSTALL fts");
        await c.run("LOAD fts");
        await c.run(`ATTACH ${lit(db)} AS ring1 (READ_ONLY)`);
      } catch (e: any) {
        instance.closeSync();
        throw new AppError(
          503,
          /lock/i.test(e.message)
            ? "The Ring 1 corpus is being rebuilt (pnpm mihrab:seed holds it). Try again when it finishes."
            : "Could not open the Ring 1 corpus: " + e.message,
        );
      } finally {
        c.closeSync();
      }
      return instance;
    })().catch((e) => {
      this.opening = undefined;
      throw e;
    });
    return this.opening;
  }

  async connection<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
    const c = await (await this.instance()).connect();
    try {
      await c.run("USE ring1");
      return await fn(c);
    } finally {
      c.closeSync();
    }
  }
  async query(sql: string, params?: Record<string, unknown>): Promise<Row[]> {
    return this.connection(async (c) =>
      (await c.runAndReadAll(sql, params as any)).getRowObjectsJS().map((r) => plain(r)) as Row[],
    );
  }
  ids(values: string[]) {
    return listValue(values);
  }

  // Loads (or reloads, when an embedding run has added parts) one
  // embedder's chunk vectors into memory, in a table of their own. Checked
  // at most once a minute.
  async vectorIndex(id: string | null = this.embedderId): Promise<VectorIndex | null> {
    if (!id) return null;
    const state = this.vectors.get(id) ?? { index: null, checkedAt: 0, stamp: 0 };
    this.vectors.set(id, state);
    if (Date.now() - state.checkedAt < 60_000) return state.index;
    state.checkedAt = Date.now();
    const metaFile = resolve(modelDir(this.dir, id), "meta.json");
    if (!existsSync(metaFile)) return (state.index = null);
    const stamp = statSync(metaFile).mtimeMs;
    if (stamp === state.stamp && state.index) return state.index;
    const meta = await readVectorMeta(this.dir, id);
    if (!meta?.count) return (state.index = null);
    const table = "memory.main.vec_" + id.replace(/[^a-zA-Z0-9]+/g, "_");
    const c = await (await this.instance()).connect();
    try {
      await c.run(
        `CREATE OR REPLACE TABLE ${table} AS SELECT chunk_key, node_id, vec::FLOAT[${meta.dims}] AS vec
         FROM read_parquet(${lit(modelDir(this.dir, id) + "/part-*.parquet")})`,
      );
    } finally {
      c.closeSync();
    }
    state.stamp = stamp;
    return (state.index = { ...meta, table });
  }

  async status() {
    if (!this.available) return { ready: false as const, dir: this.dir };
    const [counts] = await this.query(`SELECT
      (SELECT count(*) FROM quran_ayahs) AS ayahs,
      (SELECT count(*) FROM tafsir_entries) AS tafsir,
      (SELECT count(*) FROM hadeethenc_items) AS hadeethenc,
      (SELECT count(*) FROM canonical_hadiths) AS canonical,
      (SELECT count(*) FROM categories) AS categories,
      (SELECT count(*) FROM graph_edges) AS edges,
      (SELECT count(*) FROM mihrab_chunks) AS chunks`);
    const index = await this.vectorIndex();
    const vectors = index && { id: index.id, provider: index.provider, model: index.model, dims: index.dims, count: index.count };
    const types = await this.query(
      "SELECT node_type, source_table, immutable_fields FROM mihrab_node_types ORDER BY node_type",
    );
    const edges = await this.query("SELECT * FROM mihrab_edge_types ORDER BY edge_type");
    return {
      ready: true as const,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
      vectors,
      ontology: { nodeTypes: types, edgeTypes: edges },
    };
  }

  close() {
    void this.opening?.then((i) => i.closeSync()).catch(() => {});
    this.opening = undefined;
  }
}
