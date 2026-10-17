// Registers Mihrab's Ring 1 graph in a Helix Foundry workspace, so it lives
// in HelixDB as typed object types and relationships alongside the rest of
// Foundry (Records, graph explorer, Analyst).
//
// Foundry relates object types by matching a column on each side, so the
// many-to-many edges (EXPLAINS_AYAH with its coverage, CITES_AYAH,
// IN_CATEGORY) become small link object types: one record per edge with a
// relationship to each end. BELONGS_TO_SURAH is a plain column match.
import { DuckDBInstance } from "@duckdb/node-api";
import { openAsBlob } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Bundle } from "../../../../packages/shared/src/index.js";
import { NODE_TYPES } from "../../../../packages/shared/src/mihrab.js";
import { corpusPaths } from "../../../../services/executor/src/mihrab-catalog.js";

const lit = (v: string) => "'" + v.replaceAll("'", "''") + "'";
export const FOUNDRY_WORKSPACE = "Mihrab — Ring 1";

// Dataset name -> the SELECT that produces it from the catalog. List and
// struct columns are stored as JSON text.
export const FOUNDRY_TABLES: Record<string, string> = {
  ring1_surahs: "SELECT * FROM surahs",
  ring1_ayahs: `SELECT node_id, ayah_key, surah_number, ayah_number, surah_name_ar, surah_name_en,
    revelation_place, juz_number, text_uthmani, translation_en, translation_de FROM quran_ayahs`,
  ring1_tafsir: "SELECT * FROM tafsir_entries",
  ring1_hadeethenc: `SELECT * REPLACE (to_json(hints_benefits)::VARCHAR AS hints_benefits,
    to_json(categories)::VARCHAR AS categories) FROM hadeethenc_items`,
  ring1_canonical_hadith: "SELECT * REPLACE (to_json(grades)::VARCHAR AS grades) FROM canonical_hadiths",
  ring1_categories: "SELECT node_id, name, hadeethenc_id FROM categories",
  ring1_explains_ayah: `SELECT source_id || '>' || target_id AS edge_id, source_id AS tafsir_id,
    target_id AS ayah_id, coverage FROM mihrab_edges WHERE edge_type = 'EXPLAINS_AYAH'`,
  ring1_cites_ayah: `SELECT source_id || '>' || target_id AS edge_id, source_id AS tafsir_id,
    target_id AS ayah_id FROM mihrab_edges WHERE edge_type = 'CITES_AYAH'`,
  ring1_in_category: `SELECT source_id || '>' || target_id AS edge_id, source_id AS hadeeth_id,
    target_id AS category_id FROM mihrab_edges WHERE edge_type = 'IN_CATEGORY'`,
};

export async function exportFoundryTables(dir: string) {
  const out = resolve(dir, "foundry");
  await mkdir(out, { recursive: true });
  const mem = await DuckDBInstance.create(":memory:");
  const c = await mem.connect();
  const files: Record<string, string> = {};
  try {
    await c.run(`ATTACH ${lit(corpusPaths(dir).db)} AS ring1 (READ_ONLY)`);
    await c.run("USE ring1");
    for (const [name, sql] of Object.entries(FOUNDRY_TABLES)) {
      files[name] = resolve(out, name + ".parquet");
      await c.run(`COPY (${sql}) TO ${lit(files[name])} (FORMAT parquet, COMPRESSION zstd)`);
    }
  } finally {
    c.closeSync();
    mem.closeSync();
  }
  return files;
}

const immutableNote = (type: keyof typeof NODE_TYPES) =>
  NODE_TYPES[type].immutable.length
    ? ` Immutable primary text: ${NODE_TYPES[type].immutable.join(", ")} — never edit or regenerate.`
    : "";
export function ring1Bundle(ids: Record<string, string>): Bundle {
  const type = (
    name: string,
    dataset: string,
    properties: string[],
    description: string,
    primaryKey = "node_id",
  ) => ({ name, datasetId: ids[dataset], primaryKey, properties, description });
  return {
    summary: "Mihrab Ring 1: Qur'an, Tafsir Ibn Kathir, HadeethEnc and canonical hadith as a knowledge graph",
    assumptions: [
      "node_id values come from scripts/ingest_ring1.py and are the citation ids Mihrab answers use.",
      "Link types (Tafsir Explanation, Tafsir Citation, Category Membership) are one record per graph edge.",
    ],
    catalog: Object.entries(ids).map(([name, datasetId]) => ({
      datasetId,
      description: `Ring 1 golden corpus table ${name}.`,
      tags: ["mihrab", "ring1", name.includes("_ayah") || name.includes("category") ? "edge" : "node"],
    })),
    pipelines: [],
    ontology: [
      type("Surah", "ring1_surahs", ["surah_number", "name_ar", "name_en", "name_translation_en", "revelation_place", "ayah_count"], "A surah of the Qur'an."),
      type("Ayah", "ring1_ayahs", ["ayah_key", "surah_number", "ayah_number", "surah_name_ar", "surah_name_en", "revelation_place", "juz_number", "text_uthmani", "translation_en", "translation_de"], "A verse of the Qur'an: Uthmani Arabic, Sahih International (EN), Bubenheim & Elyas (DE)." + immutableNote("Ayah")),
      type("Tafsir Entry", "ring1_tafsir", ["ayah_key", "source_slug", "author_name", "language", "text_clean"], "Classical commentary (Tafsir Ibn Kathir, abridged English) anchored at an ayah."),
      type("HadeethEnc Item", "ring1_hadeethenc", ["hadeeth_id", "title_en", "title_ar", "title_de", "matn_ar", "matn_en", "matn_de", "attribution_en", "grade_en", "explanation_en", "explanation_ar", "explanation_de", "hints_benefits", "categories"], "A graded hadith from HadeethEnc.com with its explanation (Sharh) and benefits." + immutableNote("HadeethEncItem")),
      type("Canonical Hadith", "ring1_canonical_hadith", ["collection", "hadith_number", "book_number", "matn_ar", "matn_en", "grades"], "A hadith of Sahih al-Bukhari, Sahih Muslim or al-Arba'in an-Nawawiyyah." + immutableNote("CanonicalHadith")),
      type("Category", "ring1_categories", ["name", "hadeethenc_id"], "A HadeethEnc root subject category."),
      type("Tafsir Explanation", "ring1_explains_ayah", ["tafsir_id", "ayah_id", "coverage"], "EXPLAINS_AYAH: a Tafsir Entry explains an Ayah, directly or as part of the passage it covers.", "edge_id"),
      type("Tafsir Citation", "ring1_cites_ayah", ["tafsir_id", "ayah_id"], "CITES_AYAH: a Tafsir Entry cross-references another Ayah.", "edge_id"),
      type("Category Membership", "ring1_in_category", ["hadeeth_id", "category_id"], "IN_CATEGORY: a HadeethEnc Item belongs to a Category.", "edge_id"),
    ],
    relationships: [
      { name: "BELONGS_TO_SURAH", fromType: "Ayah", toType: "Surah", fromColumn: "surah_number", toColumn: "surah_number" },
      { name: "EXPLAINS_AYAH (tafsir)", fromType: "Tafsir Explanation", toType: "Tafsir Entry", fromColumn: "tafsir_id", toColumn: "node_id" },
      { name: "EXPLAINS_AYAH (ayah)", fromType: "Tafsir Explanation", toType: "Ayah", fromColumn: "ayah_id", toColumn: "node_id" },
      { name: "CITES_AYAH (tafsir)", fromType: "Tafsir Citation", toType: "Tafsir Entry", fromColumn: "tafsir_id", toColumn: "node_id" },
      { name: "CITES_AYAH (ayah)", fromType: "Tafsir Citation", toType: "Ayah", fromColumn: "ayah_id", toColumn: "node_id" },
      { name: "IN_CATEGORY (hadith)", fromType: "Category Membership", toType: "HadeethEnc Item", fromColumn: "hadeeth_id", toColumn: "node_id" },
      { name: "IN_CATEGORY (category)", fromType: "Category Membership", toType: "Category", fromColumn: "category_id", toColumn: "node_id" },
    ],
    dashboards: [],
    // No edit actions: Ring 1 records are read-only sources.
    actions: [],
  };
}

export async function registerInFoundry(opts: {
  dir: string;
  base: string;
  origin: string;
  publish?: boolean;
  workspace?: string;
  log?: (line: string) => void;
}) {
  const log = opts.log || console.log,
    base = opts.base.replace(/\/$/, "");
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + "/api/v1" + path, {
      ...init,
      headers: { origin: opts.origin, ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${init.method || "GET"} ${path}: HTTP ${r.status} ${data.error || ""}`);
    return data;
  };
  const health = await fetch(base + "/api/health").catch(() => null);
  if (!health?.ok)
    throw new Error(`Helix Foundry is not answering at ${base}. Start it (pnpm dev, or docker compose up) and run again.`);

  const name = opts.workspace || FOUNDRY_WORKSPACE;
  const me = await call("/me");
  let ws = me.workspaces.find((w: any) => w.name === name);
  ws ??= await call("/workspaces", { method: "POST", body: JSON.stringify({ name }) });
  log(`  workspace "${name}" (${ws.id})`);

  const files = await exportFoundryTables(opts.dir);
  const existing = new Map<string, string>(
    (await call(`/workspaces/${ws.id}/resources/dataset?limit=500`)).items.map((d: any) => [d.name, d.id]),
  );
  const ids: Record<string, string> = {};
  for (const [dataset, file] of Object.entries(files)) {
    if (existing.has(dataset)) {
      ids[dataset] = existing.get(dataset)!;
      log(`  dataset ${dataset} already uploaded`);
      continue;
    }
    const form = new FormData();
    form.append("file", await openAsBlob(file), basename(file));
    const d = await call(`/workspaces/${ws.id}/upload`, { method: "POST", body: form });
    ids[dataset] = d.id;
    log(`  uploaded ${dataset} → ${d.id}`);
  }
  const {
    items: [proposal],
  } = await call(`/workspaces/${ws.id}/definitions/import`, {
    method: "POST",
    body: JSON.stringify({ version: 1, proposals: [ring1Bundle(ids)] }),
  });
  const failed = proposal.data.validation.checks.filter((c: any) => !c.passed);
  if (failed.length) {
    for (const c of failed) log(`  ✗ ${c.name}: ${c.detail}`);
    throw new Error("The Ring 1 ontology did not pass Foundry's validation.");
  }
  log(`  ✓ ontology proposal ${proposal.id} validated (${proposal.data.validation.checks.length} checks)`);
  if (!opts.publish) {
    log("  Review it under Workspace → Reviews and publish it, or re-run with --publish.");
    return { workspaceId: ws.id, proposalId: proposal.id, published: false };
  }
  await call(`/workspaces/${ws.id}/proposals/${proposal.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ hash: proposal.data.hash }),
  });
  log("  ✓ published to HelixDB");
  return { workspaceId: ws.id, proposalId: proposal.id, published: true };
}
