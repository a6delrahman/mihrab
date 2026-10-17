// Mihrab's Ring 1 catalog in DuckDB: registers the golden corpus's Parquet
// tables, records the ontology, splits texts into per-language search chunks
// and builds a BM25 index for each language. Used by
// scripts/seed_mihrab_ontology.ts; the API opens the result read-only.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  EDGE_TYPES,
  NODE_TYPES,
  normalizeArabic,
  type Lang,
  type NodeType,
} from "../../../packages/shared/src/mihrab.js";

export const corpusPaths = (dir: string) => ({
  dir,
  parquet: resolve(dir, "parquet"),
  db: resolve(dir, "ring1_knowledge.duckdb"),
  embeddings: resolve(dir, "embeddings"),
});
const lit = (v: string) => "'" + v.replaceAll("'", "''") + "'";
// Tables the corpus builder writes, in load order.
export const CORPUS_TABLES = [
  "surahs",
  "quran_ayahs",
  "tafsir_entries",
  "hadeethenc_items",
  "canonical_hadiths",
  "categories",
  "graph_edges",
] as const;
// Tables registered when present (corpora built before they existed lack them).
export const OPTIONAL_TABLES = ["collection_books"] as const;
export const STEMMERS: Record<Lang, string> = {
  en: "english",
  de: "german",
  ar: "arabic",
};
// Letters and digits in any script make tokens; DuckDB's default keeps only
// a-z, which would drop Arabic and German umlauts.
const IGNORE = "(\\.|[^\\p{L}\\p{N}])+";

export type Chunk = {
  chunk_key: string;
  node_id: string;
  node_type: NodeType;
  lang: Lang;
  seq: number;
  text: string;
  search_text: string;
};
export const MAX_CHUNK = 1200;
// Splits prose at paragraph, then sentence, boundaries into pieces of at
// most `max` characters. Deterministic, so chunk keys stay stable.
export function splitText(text: string, max = MAX_CHUNK): string[] {
  // Units no longer than max: whole paragraphs, or the sentences of a long
  // one (a sentence longer than max is cut at max), with the glue that
  // rejoins them.
  const units: { text: string; glue: string }[] = [];
  for (const para of text.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= max) {
      units.push({ text: para, glue: "\n" });
      continue;
    }
    let glue = "\n";
    for (const sentence of para.match(/[^.!?؟۔]+[.!?؟۔]*/g) || [para]) {
      const s = sentence.trim();
      for (let i = 0; i < s.length; i += max) {
        units.push({ text: s.slice(i, i + max), glue });
        glue = " ";
      }
    }
  }
  const out: string[] = [];
  for (const u of units) {
    const last = out.length - 1;
    if (last >= 0 && out[last].length + u.text.length + 1 <= max) out[last] += u.glue + u.text;
    else out.push(u.text);
  }
  return out;
}

export async function rows(c: DuckDBConnection, sql: string, params?: Record<string, any>) {
  return (await c.runAndReadAll(sql, params)).getRowObjectsJS() as Record<string, any>[];
}

function chunksFor(type: NodeType, r: Record<string, any>): Chunk[] {
  const out: Chunk[] = [];
  const add = (lang: Lang, texts: string[], start = 0) =>
    texts.forEach((text, i) => {
      if (!text?.trim()) return;
      out.push({
        chunk_key: `${r.node_id}#${lang}#${start + i}`,
        node_id: r.node_id,
        node_type: type,
        lang,
        seq: start + i,
        text,
        search_text: lang === "ar" ? normalizeArabic(text) : text,
      });
    });
  switch (type) {
    case "Ayah":
      add("en", [`${r.surah_name_en} (${r.ayah_key}): ${r.translation_en}`]);
      add("de", [`${r.surah_name_en} (${r.ayah_key}): ${r.translation_de}`]);
      add("ar", [`${r.surah_name_ar} ${r.text_uthmani}`]);
      break;
    case "TafsirEntry":
      add(r.language as Lang, splitText(r.text_clean));
      break;
    case "HadeethEncItem": {
      const hints = (r.hints_benefits || []).join("\n");
      add("en", [`${r.title_en}\n${r.matn_en}`, ...splitText(r.explanation_en || ""), hints]);
      if (r.matn_de)
        add("de", [`${r.title_de || ""}\n${r.matn_de}`, ...splitText(r.explanation_de || "")]);
      add("ar", [`${r.title_ar}\n${r.matn_ar}`, ...splitText(r.explanation_ar || "")]);
      break;
    }
    case "CanonicalHadith":
      add("en", splitText(r.matn_en, 1600));
      add("ar", splitText(r.matn_ar, 1600));
      break;
  }
  return out;
}

export type CatalogReport = {
  tables: Record<string, number>;
  chunks: Record<Lang, number>;
  danglingEdges: { edge_type: string; side: string; count: number }[];
  ayahsWithoutTafsir: string[];
};

// True when the catalog exists and is newer than every Parquet table, so a
// re-run (for instance `--foundry` while the app holds the file open
// read-only) need not take the write lock.
export async function catalogCurrent(dir: string) {
  const p = corpusPaths(dir);
  if (!existsSync(p.db)) return false;
  const built = statSync(p.db).mtimeMs;
  if (CORPUS_TABLES.some((t) => !existsSync(resolve(p.parquet, t + ".parquet")) || statSync(resolve(p.parquet, t + ".parquet")).mtimeMs > built))
    return false;
  if (OPTIONAL_TABLES.some((t) => existsSync(resolve(p.parquet, t + ".parquet")) && statSync(resolve(p.parquet, t + ".parquet")).mtimeMs > built))
    return false;
  const db = await DuckDBInstance.create(p.db, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    const [r] = await rows(c, "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name IN ('mihrab_chunks', 'mihrab_search_ar', 'mihrab_node_types')");
    return Number(r.n) === 3;
  } finally {
    c.closeSync();
    db.closeSync();
  }
}

export async function buildCatalog(
  dir: string,
  log: (line: string) => void = console.log,
): Promise<CatalogReport> {
  const p = corpusPaths(dir);
  for (const t of CORPUS_TABLES)
    if (!existsSync(resolve(p.parquet, t + ".parquet")))
      throw new Error(`Missing ${t}.parquet in ${p.parquet}. Run scripts/ingest_ring1.py first.`);
  const db = await DuckDBInstance.create(p.db);
  const c = await db.connect();
  try {
    await c.run("INSTALL fts");
    await c.run("LOAD fts");
    const tables: Record<string, number> = {};
    for (const t of CORPUS_TABLES) {
      await c.run(
        `CREATE OR REPLACE TABLE ${t} AS SELECT * FROM read_parquet(${lit(resolve(p.parquet, t + ".parquet"))})`,
      );
      tables[t] = Number((await rows(c, `SELECT count(*) AS n FROM ${t}`))[0].n);
      log(`  registered ${t.padEnd(18)} ${tables[t].toLocaleString("en-US").padStart(8)} rows`);
    }
    for (const t of OPTIONAL_TABLES) {
      const file = resolve(p.parquet, t + ".parquet");
      if (!existsSync(file)) {
        log(`  (no ${t}.parquet: run python3 scripts/ingest_ring1.py --books-only)`);
        continue;
      }
      await c.run(`CREATE OR REPLACE TABLE ${t} AS SELECT * FROM read_parquet(${lit(file)})`);
      tables[t] = Number((await rows(c, `SELECT count(*) AS n FROM ${t}`))[0].n);
      log(`  registered ${t.padEnd(18)} ${tables[t].toLocaleString("en-US").padStart(8)} rows`);
    }

    // The ontology itself, so the catalog describes its own graph.
    await c.run(`CREATE OR REPLACE TABLE mihrab_node_types (
      node_type VARCHAR PRIMARY KEY, source_table VARCHAR, id_prefix VARCHAR,
      fields VARCHAR[], immutable_fields VARCHAR[])`);
    for (const [type, d] of Object.entries(NODE_TYPES))
      await c.run(
        `INSERT INTO mihrab_node_types VALUES ($t, $tbl, $p, $f::VARCHAR[], $i::VARCHAR[])`,
        { t: type, tbl: d.table, p: d.prefix, f: JSON.stringify(d.fields), i: JSON.stringify(d.immutable) },
      );
    await c.run(`CREATE OR REPLACE TABLE mihrab_edge_types (
      edge_type VARCHAR PRIMARY KEY, from_type VARCHAR, to_type VARCHAR)`);
    for (const [type, d] of Object.entries(EDGE_TYPES))
      await c.run(`INSERT INTO mihrab_edge_types VALUES ($t, $f, $to)`, { t: type, f: d.from, to: d.to });

    // Each canonical hadith's book (kitab). The hadith's own reference is
    // authoritative; the source's book ranges overlap where a book holds
    // out-of-order hadiths, so they only place hadiths with no reference,
    // in the narrowest range that contains them.
    if (tables.collection_books !== undefined)
      await c.run(`CREATE OR REPLACE TABLE mihrab_hadith_books AS
        SELECT h.node_id, h.collection, h.hadith_number,
          coalesce(
            (SELECT b.book_number FROM collection_books b
              WHERE b.collection = h.collection AND b.book_number = h.book_number AND h.book_number > 0),
            (SELECT b.book_number FROM collection_books b
              WHERE b.collection = h.collection AND h.hadith_number BETWEEN b.hadith_first AND b.hadith_last
              ORDER BY b.hadith_last - b.hadith_first LIMIT 1)) AS book_number
        FROM canonical_hadiths h`);

    // One registry of every node, for id lookups and integrity checks.
    await c.run(`CREATE OR REPLACE TABLE mihrab_nodes AS
      SELECT node_id, 'Surah' AS node_type, name_en || ' (' || surah_number || ')' AS label FROM surahs
      UNION ALL SELECT node_id, 'Ayah', surah_name_en || ' ' || ayah_key FROM quran_ayahs
      UNION ALL SELECT node_id, 'TafsirEntry', author_name || ' on ' || ayah_key FROM tafsir_entries
      UNION ALL SELECT node_id, 'HadeethEncItem', title_en FROM hadeethenc_items
      UNION ALL SELECT node_id, 'CanonicalHadith', collection || ' ' || hadith_number FROM canonical_hadiths
      UNION ALL SELECT node_id, 'Category', name FROM categories`);
    await c.run(`CREATE OR REPLACE TABLE mihrab_edges AS
      SELECT source_id, target_id, edge_type,
        coalesce(json_extract_string(metadata, '$.coverage'), 'direct') AS coverage
      FROM graph_edges`);
    const danglingEdges = (
      await rows(
        c,
        `SELECT edge_type, side, count(*) AS count FROM (
           SELECT edge_type, 'source' AS side FROM mihrab_edges e
             WHERE NOT EXISTS (SELECT 1 FROM mihrab_nodes n WHERE n.node_id = e.source_id)
           UNION ALL
           SELECT edge_type, 'target' FROM mihrab_edges e
             WHERE NOT EXISTS (SELECT 1 FROM mihrab_nodes n WHERE n.node_id = e.target_id))
         GROUP BY ALL ORDER BY ALL`,
      )
    ).map((r) => ({ ...r, count: Number(r.count) })) as CatalogReport["danglingEdges"];
    const ayahsWithoutTafsir = (
      await rows(
        c,
        `SELECT node_id FROM quran_ayahs a WHERE NOT EXISTS (
           SELECT 1 FROM mihrab_edges e WHERE e.edge_type = 'EXPLAINS_AYAH' AND e.target_id = a.node_id)
         ORDER BY surah_number, ayah_number`,
      )
    ).map((r) => r.node_id as string);

    // Search chunks.
    const chunks: Chunk[] = [];
    const sources: [NodeType, string][] = [
      ["Ayah", "quran_ayahs"],
      ["TafsirEntry", "tafsir_entries"],
      ["HadeethEncItem", "hadeethenc_items"],
      ["CanonicalHadith", "canonical_hadiths"],
    ];
    for (const [type, table] of sources)
      for (const r of await rows(c, `SELECT * FROM ${table}`)) chunks.push(...chunksFor(type, r));
    await c.run(`CREATE OR REPLACE TABLE mihrab_chunks (
      chunk_id INTEGER PRIMARY KEY, chunk_key VARCHAR UNIQUE, node_id VARCHAR, node_type VARCHAR,
      lang VARCHAR, seq INTEGER, text VARCHAR, search_text VARCHAR)`);
    const app = await c.createAppender("mihrab_chunks");
    chunks.forEach((k, i) => {
      app.appendInteger(i + 1);
      app.appendVarchar(k.chunk_key);
      app.appendVarchar(k.node_id);
      app.appendVarchar(k.node_type);
      app.appendVarchar(k.lang);
      app.appendInteger(k.seq);
      app.appendVarchar(k.text);
      app.appendVarchar(k.search_text);
      app.endRow();
    });
    app.closeSync();
    const counts = { en: 0, de: 0, ar: 0 } as Record<Lang, number>;
    for (const k of chunks) counts[k.lang]++;
    for (const lang of Object.keys(STEMMERS) as Lang[]) {
      const t = `mihrab_search_${lang}`;
      await c.run(
        `CREATE OR REPLACE TABLE ${t} AS SELECT chunk_id, search_text FROM mihrab_chunks WHERE lang = ${lit(lang)}`,
      );
      await c.run(
        `PRAGMA create_fts_index(${lit(t)}, 'chunk_id', 'search_text', stemmer=${lit(STEMMERS[lang])}, ignore=${lit(IGNORE)}, strip_accents=0, lower=1, overwrite=1)`,
      );
      log(`  BM25 index ${t.padEnd(16)} ${counts[lang].toLocaleString("en-US").padStart(8)} chunks (${STEMMERS[lang]} stemmer)`);
    }
    // A read-only open does not replay the write-ahead log.
    await c.run("CHECKPOINT");
    return { tables, chunks: counts, danglingEdges, ayahsWithoutTafsir };
  } finally {
    c.closeSync();
    db.closeSync();
  }
}
