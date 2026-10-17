// Mihrab's three-stage multi-hop retrieval. It runs to completion before the
// model sees a single token:
//
// 1. Hybrid entry points: BM25 over the question's language (Snowball
//    stemmers for English, German and Arabic) fused by reciprocal rank with
//    vector similarity over the multilingual chunk embeddings, plus any
//    explicit references ("2:255", "Bukhari 1").
// 2. Epistemological expansion along the graph: every Ayah brings its Ibn
//    Kathir TafsirEntry (EXPLAINS_AYAH, direct or the passage it belongs to)
//    and the ayahs that commentary cites (CITES_AYAH), each again with its
//    own Tafsir, so no verse reaches the model without its classical
//    explanation. A TafsirEntry brings the ayahs it explains. Every hadith
//    brings its grade (or collection status), attribution and Sharh.
// 3. The context the prompt is built from, with verbatim primary texts
//    kept apart from what the model may write (see mihrabPrompt.ts).
import {
  COLLECTIONS,
  detectLang,
  normalizeArabic,
  type HadithGrade,
  type Lang,
  type NodeType,
  type Persona,
  type RetrievalTrace,
  type SourceNode,
  type TraceEdge,
  type TraceNode,
} from "../../../../packages/shared/src/mihrab.js";
import type { Embedder } from "../../../../services/executor/src/mihrab-vectors.js";
import type { MihrabCorpus, Row } from "./mihrabCorpus.js";

export type ContextNode = {
  id: string;
  type: NodeType;
  hop: 0 | 1 | 2;
  label: string;
  // What the model reads. Primary texts are marked so it presents them only
  // through {{quote:id}}.
  body: string;
  notes: string[];
};
export type Retrieval = {
  searchLang: Lang;
  trace: RetrievalTrace;
  sources: Record<string, SourceNode>;
  context: ContextNode[];
};
type Hit = {
  chunk_key: string;
  node_id: string;
  node_type: NodeType;
  seq: number;
  text: string;
  score: number;
};
type Candidate = {
  id: string;
  type: NodeType;
  score: number;
  via: string[];
  seqs: number[];
};

const RRF_K = 60;
const LIST_K = 30;
const LIMITS: Record<
  Persona,
  { entries: number; perType: Partial<Record<NodeType, number>>; cited: number; tafsirChars: number; citedChars: number; sharhChars: number }
> = {
  explorer: {
    entries: 5,
    perType: { Ayah: 2, TafsirEntry: 2, HadeethEncItem: 2, CanonicalHadith: 1 },
    cited: 1,
    tafsirChars: 1400,
    citedChars: 500,
    sharhChars: 1000,
  },
  scholar: {
    entries: 8,
    perType: { Ayah: 4, TafsirEntry: 3, HadeethEncItem: 3, CanonicalHadith: 3 },
    cited: 3,
    tafsirChars: 2600,
    citedChars: 800,
    sharhChars: 2200,
  },
};
const TABLE: Partial<Record<NodeType, string>> = {
  Surah: "surahs",
  Ayah: "quran_ayahs",
  TafsirEntry: "tafsir_entries",
  HadeethEncItem: "hadeethenc_items",
  CanonicalHadith: "canonical_hadiths",
  Category: "categories",
};

// A question that leans on the one before it: short ("and in hadith?") or
// pointing back ("what does Ibn Kathir say about its virtue?"). It is
// searched together with the previous question.
const POINTS_BACK = /\b(it|its|it's|this|that|these|those|they|them|their|he|him|his|she|her|es|sein|seine|seinen|ihr|ihre|ihren|dies|diese|dieser|dieses|davon|darüber|dazu)\b|(?:^|\s)(هذا|هذه|ذلك|تلك|هو|هي|فيها|عنها|فيه|عنه)(?:\s|$|[؟?.,])/i;
export function isFollowUp(question: string) {
  return question.trim().split(/\s+/).length < 6 || POINTS_BACK.test(question);
}

// "2:255", "Bukhari 1", "Sahih Muslim no. 2564", "Nawawi #13".
export function explicitRefs(q: string): string[] {
  const ids: string[] = [];
  for (const m of q.matchAll(/(?<![\d:])(\d{1,3})\s*[:：]\s*(\d{1,3})(?![\d:])/g))
    ids.push(`ayah:${Number(m[1])}:${Number(m[2])}`);
  for (const m of q.matchAll(/\b(bukh[aā]r[iī]|muslim|nawaw[iī])\b[^\d\n]{0,15}?(\d{1,4})\b/gi)) {
    const c = /^b/i.test(m[1]) ? "bukhari" : /^m/i.test(m[1]) ? "muslim" : "nawawi40";
    ids.push(`hadith:${c}:${Number(m[2])}`);
  }
  return [...new Set(ids)];
}

// Reciprocal rank fusion at node level: each list adds 1/(k + rank) for the
// first chunk of a node it ranks; up to three matching chunks are kept.
export function fuse(lists: [string, Hit[]][], boosts: string[] = []): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const [name, hits] of lists) {
    const seen = new Set<string>();
    hits.forEach((h, rank) => {
      const c = out.get(h.node_id) ?? { id: h.node_id, type: h.node_type, score: 0, via: [], seqs: [] };
      if (!seen.has(h.node_id)) {
        c.score += 1 / (RRF_K + rank + 1);
        c.via.push(name);
        seen.add(h.node_id);
      }
      if (c.seqs.length < 3 && !c.seqs.includes(h.seq)) c.seqs.push(h.seq);
      out.set(h.node_id, c);
    });
  }
  return [...out.values()]
    .map((c) =>
      boosts.includes(c.id)
        ? { ...c, score: c.score + 1, via: c.via.includes("reference") ? c.via : ["reference", ...c.via] }
        : c,
    )
    .sort((a, b) => b.score - a.score);
}

export function pickEntries(cands: Candidate[], persona: Persona) {
  const lim = LIMITS[persona],
    taken: Candidate[] = [],
    per: Record<string, number> = {};
  for (const c of cands) {
    if (taken.length >= lim.entries) break;
    if ((per[c.type] || 0) >= (lim.perType[c.type] ?? 0)) continue;
    per[c.type] = (per[c.type] || 0) + 1;
    taken.push(c);
  }
  return taken;
}

// The opening chunk plus the chunks that matched, in order, within budget.
export function excerpt(chunks: { seq: number; text: string }[], prefer: number[], budget: number) {
  const want = [...new Set([0, ...prefer])].sort((a, b) => a - b);
  let out = "",
    prev = -1;
  for (const seq of want) {
    const c = chunks.find((x) => x.seq === seq);
    if (!c) continue;
    const sep = out ? (seq === prev + 1 ? "\n" : "\n[…]\n") : "";
    const room = budget - out.length - sep.length;
    if (room < 120) break;
    out += sep + (c.text.length > room ? c.text.slice(0, room).replace(/\s+\S*$/, "") + " […]" : c.text);
    prev = seq;
  }
  return out;
}

function hadithGrade(type: NodeType, r: Row): HadithGrade {
  if (type === "HadeethEncItem")
    return r.grade_en ? { label: r.grade_en, basis: "graded", detail: "HadeethEnc" } : { label: "Grade not recorded", basis: "unknown" };
  const grades = (r.grades || []) as { name: string; grade: string }[];
  if (grades.length)
    return { label: grades[0].grade, basis: "graded", detail: grades.map((g) => `${g.name}: ${g.grade}`).join("; ") };
  const status = COLLECTIONS[r.collection]?.status;
  return status
    ? { label: status, basis: "collection", detail: `Status of ${COLLECTIONS[r.collection].name} as a collection` }
    : { label: "Grade not recorded", basis: "unknown" };
}
const pickLang = (lang: Lang, by: Partial<Record<Lang, string | null>>): [string, Lang] =>
  by[lang] ? [by[lang]!, lang] : [by.en || "", "en"];

export function toSource(type: NodeType, r: Row, lang: Lang): SourceNode {
  const base = { node_id: r.node_id as string, type, meta: {} as SourceNode["meta"] };
  switch (type) {
    case "Ayah":
      return {
        ...base,
        title: `${r.surah_name_en} ${r.ayah_key}`,
        arabic: r.text_uthmani,
        translation: { en: r.translation_en, de: r.translation_de },
        meta: {
          surah: r.surah_name_en,
          surah_ar: r.surah_name_ar,
          ayah_key: r.ayah_key,
          revelation: r.revelation_place,
          juz: r.juz_number ?? null,
          translation_en: "Sahih International",
          translation_de: "Bubenheim & Elyas",
        },
      };
    case "TafsirEntry":
      return {
        ...base,
        title: `${r.author_name} on ${r.ayah_key}`,
        commentary: r.text_clean,
        commentaryLang: "en",
        meta: { author: r.author_name, source: r.source_slug, ayah_key: r.ayah_key, language: r.language },
      };
    case "HadeethEncItem": {
      const [commentary, commentaryLang] = pickLang(lang, {
        en: r.explanation_en,
        de: r.explanation_de,
        ar: r.explanation_ar,
      });
      return {
        ...base,
        title: pickLang(lang, { en: r.title_en, de: r.title_de, ar: r.title_ar })[0],
        arabic: r.matn_ar,
        translation: { en: r.matn_en, ...(r.matn_de ? { de: r.matn_de } : {}) },
        grade: hadithGrade(type, r),
        attribution: r.attribution_en,
        commentary,
        commentaryLang,
        benefits: r.hints_benefits || [],
        meta: { source: "HadeethEnc.com", hadeeth_id: r.hadeeth_id, categories: (r.categories || []).join(", ") },
      };
    }
    case "CanonicalHadith":
      return {
        ...base,
        title: `${COLLECTIONS[r.collection]?.name || r.collection} ${r.hadith_number}`,
        arabic: r.matn_ar,
        translation: { en: r.matn_en },
        grade: hadithGrade(type, r),
        meta: { collection: r.collection, hadith_number: r.hadith_number, book: r.book_number },
      };
    case "Category":
      return { ...base, title: r.name, meta: {} };
    case "Surah":
      return {
        ...base,
        title: `${r.name_en} (${r.surah_number})`,
        meta: { name_ar: r.name_ar, meaning: r.name_translation_en, revelation: r.revelation_place, ayahs: r.ayah_count },
      };
  }
}

export type Ranking = {
  searchLang: Lang;
  candidates: Candidate[];
  lexical: Hit[];
  semantic: Hit[] | null;
  known: Set<string>;
  notes: string[];
};

export class MihrabRetriever {
  // Without an embedder, retrieval is BM25 only.
  constructor(
    private corpus: MihrabCorpus,
    readonly embedder: Embedder | null = null,
  ) {}

  async bm25(lang: Lang, q: string, k = LIST_K): Promise<Hit[]> {
    const text = lang === "ar" ? normalizeArabic(q) : q;
    const t = `mihrab_search_${lang}`;
    return (await this.corpus.query(
      `SELECT c.chunk_key, c.node_id, c.node_type, c.seq, c.text, s.score
       FROM (SELECT chunk_id, fts_main_${t}.match_bm25(chunk_id, $q) AS score FROM ${t}) s
       JOIN mihrab_chunks c USING (chunk_id)
       WHERE s.score IS NOT NULL ORDER BY s.score DESC LIMIT ${k}`,
      { q: text },
    )) as Hit[];
  }

  async vector(q: string, k = LIST_K): Promise<Hit[] | null> {
    if (!this.embedder) return null;
    const index = await this.corpus.vectorIndex(this.embedder.id);
    if (!index) return null;
    const [vec] = await this.embedder.embed([q], "query", AbortSignal.timeout(15000));
    return (await this.corpus.query(
      `SELECT v.chunk_key, v.node_id, c.node_type, c.seq, c.text,
              array_cosine_similarity(v.vec, $e::FLOAT[${index.dims}]) AS score
       FROM ${index.table} v JOIN mihrab_chunks c USING (chunk_key)
       ORDER BY score DESC LIMIT ${k}`,
      { e: JSON.stringify(vec) },
    )) as Hit[];
  }

  // Stage 1 on its own: the fused, ranked entry-point candidates.
  async rank(query: string, opts: { searchLang?: Lang; bm25?: boolean; vector?: boolean } = {}): Promise<Ranking> {
    const searchLang = opts.searchLang ?? detectLang(query);
    const notes: string[] = [];
    const refs = explicitRefs(query);
    const known = refs.length
      ? new Set(
          (await this.corpus.query(`SELECT node_id FROM mihrab_nodes WHERE node_id = ANY($ids)`, {
            ids: this.corpus.ids(refs),
          })).map((r) => r.node_id as string),
        )
      : new Set<string>();
    const refHits: Hit[] = [...known].map((id) => ({
      chunk_key: `${id}#ref`,
      node_id: id,
      node_type: id.startsWith("ayah:") ? "Ayah" : "CanonicalHadith",
      seq: 0,
      text: "",
      score: 1,
    }));
    const [lexical, semantic] = await Promise.all([
      opts.bm25 === false ? Promise.resolve([] as Hit[]) : this.bm25(searchLang, query),
      opts.vector === false
        ? Promise.resolve(null)
        : this.vector(query).catch((e: Error) => {
            notes.push(`Vector search unavailable (${e.message.slice(0, 120)}); BM25 only.`);
            return null;
          }),
    ]);
    if (semantic === null && !notes.length && opts.vector !== false)
      notes.push(
        this.embedder
          ? `No ${this.embedder.id} embeddings loaded yet (pnpm mihrab:seed); BM25 only.`
          : "No embedder configured; BM25 only.",
      );
    const lists: [string, Hit[]][] = [];
    if (opts.bm25 !== false) lists.push([`bm25:${searchLang}`, lexical]);
    if (semantic) lists.push(["vector", semantic]);
    if (refHits.length) lists.unshift(["reference", refHits]);
    // When the question names a reference, other entry points must be found
    // by both searches; the rest of such a question is usually filler.
    // (With one search there is nothing to agree with.)
    const searches = lists.filter(([name]) => name !== "reference").length;
    const candidates = fuse(lists, [...known]).filter(
      (c) => !known.size || known.has(c.id) || c.via.filter((v) => v !== "reference").length >= searches,
    );
    return { searchLang, candidates, lexical, semantic, known, notes };
  }

  private async records(ids: string[], type: NodeType) {
    const table = TABLE[type];
    if (!ids.length || !table) return new Map<string, Row>();
    const rows = await this.corpus.query(`SELECT * FROM ${table} WHERE node_id = ANY($ids)`, {
      ids: this.corpus.ids(ids),
    });
    return new Map(rows.map((r) => [r.node_id as string, r]));
  }
  private edges(type: string, side: "source_id" | "target_id", ids: string[]) {
    if (!ids.length) return Promise.resolve([] as Row[]);
    return this.corpus.query(
      `SELECT source_id, target_id, edge_type, coverage FROM mihrab_edges
       WHERE edge_type = $t AND ${side} = ANY($ids)`,
      { t: type, ids: this.corpus.ids(ids) },
    );
  }
  private async tafsirChunks(ids: string[]) {
    const out = new Map<string, { seq: number; text: string }[]>();
    if (!ids.length) return out;
    for (const r of await this.corpus.query(
      `SELECT node_id, seq, text FROM mihrab_chunks WHERE node_id = ANY($ids) ORDER BY node_id, seq`,
      { ids: this.corpus.ids(ids) },
    ))
      out.set(r.node_id, [...(out.get(r.node_id) || []), { seq: r.seq, text: r.text }]);
    return out;
  }

  async retrieve(opts: { question: string; lang: Lang; persona: Persona; history?: { role: string; content: string }[] }): Promise<Retrieval> {
    const { persona } = opts;
    const lim = LIMITS[persona];
    const stages: RetrievalTrace["stages"] = [];
    const notes: string[] = [];
    let t0 = Date.now();
    // A short follow-up ("and in hadith?") is searched with the question before it.
    const previous = [...(opts.history || [])].reverse().find((m) => m.role === "user")?.content;
    const query = previous && isFollowUp(opts.question) ? `${previous}\n${opts.question}` : opts.question;
    // ---------- Stage 1: hybrid entry points ----------
    const { searchLang, candidates, lexical, semantic, known, notes: rankNotes } = await this.rank(query, {
      searchLang: detectLang(opts.question),
    });
    notes.push(...rankNotes);
    const entries = pickEntries(candidates, persona);
    stages.push({
      name: "Hybrid entry points",
      ms: Date.now() - t0,
      detail: `BM25 (${searchLang}) ${lexical.length} hits${semantic ? `, vector ${semantic.length} hits` : ""}${known.size ? `, ${known.size} explicit reference(s)` : ""} → ${entries.length} entry nodes`,
    });

    // ---------- Stage 2: epistemological graph expansion ----------
    t0 = Date.now();
    const nodes = new Map<string, TraceNode>();
    const edges: TraceEdge[] = [];
    const prefer = new Map<string, number[]>(); // tafsir id -> chunk seqs to show
    const addNode = (n: TraceNode) => {
      const had = nodes.get(n.id);
      if (!had || n.hop < had.hop) nodes.set(n.id, { ...had, ...n });
    };
    const addEdge = (e: TraceEdge) => {
      if (!edges.some((x) => x.from === e.from && x.to === e.to && x.type === e.type)) edges.push(e);
    };
    // Any commentary chunk that matched the question is the part to show,
    // whether or not that TafsirEntry became an entry point itself.
    for (const c of candidates) if (c.type === "TafsirEntry") prefer.set(c.id, c.seqs);
    for (const e of entries)
      addNode({ id: e.id, type: e.type, label: e.id, hop: 0, score: Number(e.score.toFixed(4)), via: e.via });
    const entryIds = (t: NodeType) => entries.filter((e) => e.type === t).map((e) => e.id);

    // Tafsir entry → the ayahs it explains (its own ayah first, then up to
    // two more of its passage).
    const directFirst = (r: Row) => (r.coverage === "direct" ? 0 : 1);
    for (const [tafsir, list] of groupBy(await this.edges("EXPLAINS_AYAH", "source_id", entryIds("TafsirEntry")), "source_id"))
      list
        .sort((a, b) => directFirst(a) - directFirst(b) || a.target_id.localeCompare(b.target_id, "en", { numeric: true }))
        .slice(0, 3)
        .forEach((r) => {
          addNode({ id: r.target_id, type: "Ayah", label: r.target_id, hop: 1 });
          addEdge({ from: tafsir, to: r.target_id, type: "EXPLAINS_AYAH", coverage: r.coverage });
        });

    // Every ayah so far → its Tafsir (hop 1).
    const hop01Ayahs = [...nodes.values()].filter((n) => n.type === "Ayah").map((n) => n.id);
    const explains = await this.edges("EXPLAINS_AYAH", "target_id", hop01Ayahs);
    for (const r of explains) {
      addNode({ id: r.source_id, type: "TafsirEntry", label: r.source_id, hop: 1 });
      addEdge({ from: r.source_id, to: r.target_id, type: "EXPLAINS_AYAH", coverage: r.coverage });
    }
    // Their commentary → the ayahs it cites (hop 2), preferring the ones
    // named in the excerpt the model will read.
    const hop1Tafsir = [...nodes.values()].filter((n) => n.type === "TafsirEntry").map((n) => n.id);
    let chunks = await this.tafsirChunks(hop1Tafsir);
    const excerpts = new Map<string, string>();
    for (const id of hop1Tafsir)
      excerpts.set(id, excerpt(chunks.get(id) || [], prefer.get(id) || [], lim.tafsirChars));
    // Taken round-robin across the commentaries, entry-point Tafsir first, so
    // one long commentary does not use the whole allowance.
    const cites = await this.edges("CITES_AYAH", "source_id", hop1Tafsir);
    const queues = [...groupBy(cites, "source_id")]
      .sort(([a], [b]) => (nodes.get(a)?.hop ?? 1) - (nodes.get(b)?.hop ?? 1))
      .map(([tafsir, list]) => {
        const text = excerpts.get(tafsir) || "";
        const named = (r: Row) => new RegExp(`(?<![\\d:])${r.target_id.slice(5)}(?![\\d:])`).test(text);
        return [...list.filter(named), ...list.filter((r) => !named(r))].filter((r) => !nodes.has(r.target_id));
      });
    const cited: Row[] = [];
    while (cited.length < lim.cited && queues.some((q) => q.length))
      for (const q of queues) {
        const r = q.shift();
        if (r && cited.length < lim.cited && !cited.some((c) => c.target_id === r.target_id)) cited.push(r);
      }
    for (const r of cited) {
      addNode({ id: r.target_id, type: "Ayah", label: r.target_id, hop: 2 });
      addEdge({ from: r.source_id, to: r.target_id, type: "CITES_AYAH" });
    }
    // …and each cited ayah's own Tafsir, so it is not passed alone.
    const hop2Ayahs = [...nodes.values()].filter((n) => n.hop === 2 && n.type === "Ayah").map((n) => n.id);
    for (const r of await this.edges("EXPLAINS_AYAH", "target_id", hop2Ayahs)) {
      addNode({ id: r.source_id, type: "TafsirEntry", label: r.source_id, hop: 2 });
      addEdge({ from: r.source_id, to: r.target_id, type: "EXPLAINS_AYAH", coverage: r.coverage });
    }
    const newTafsir = [...nodes.values()].filter((n) => n.type === "TafsirEntry" && !excerpts.has(n.id)).map((n) => n.id);
    chunks = await this.tafsirChunks(newTafsir);
    for (const id of newTafsir) excerpts.set(id, excerpt(chunks.get(id) || [], [], lim.citedChars));

    // Ayahs → Surah; HadeethEnc → Category.
    const allAyahs = [...nodes.values()].filter((n) => n.type === "Ayah").map((n) => n.id);
    for (const r of await this.edges("BELONGS_TO_SURAH", "source_id", allAyahs)) {
      addNode({ id: r.target_id, type: "Surah", label: r.target_id, hop: 1 });
      addEdge({ from: r.source_id, to: r.target_id, type: "BELONGS_TO_SURAH" });
    }
    for (const r of await this.edges("IN_CATEGORY", "source_id", entryIds("HadeethEncItem"))) {
      addNode({ id: r.target_id, type: "Category", label: r.target_id, hop: 1 });
      addEdge({ from: r.source_id, to: r.target_id, type: "IN_CATEGORY" });
    }

    // Load every node's record, verbatim.
    const byType = groupBy([...nodes.values()], "type");
    const records = new Map<string, Row>();
    for (const [type, list] of byType)
      for (const [id, r] of await this.records(list.map((n) => n.id), type as NodeType)) records.set(id, r);
    for (const id of [...nodes.keys()])
      if (!records.has(id)) {
        nodes.delete(id);
        notes.push(`Dropped ${id}: not in the corpus.`);
      }
    const sources: Record<string, SourceNode> = {};
    for (const n of nodes.values()) {
      const s = toSource(n.type, records.get(n.id)!, opts.lang);
      sources[n.id] = s;
      n.label = s.title;
    }
    const traceEdges = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));

    // Invariant: each Ayah in the context has its Tafsir, or says why not.
    const tafsirFor = new Map<string, TraceEdge>();
    for (const e of traceEdges) if (e.type === "EXPLAINS_AYAH" && !tafsirFor.has(e.to)) tafsirFor.set(e.to, e);
    const missing = [...nodes.values()].filter((n) => n.type === "Ayah" && !tafsirFor.has(n.id)).map((n) => n.id);
    if (missing.length)
      notes.push(`No Ibn Kathir commentary exists in Ring 1 for ${missing.join(", ")} (absent from the source edition).`);
    stages.push({
      name: "Epistemological expansion",
      ms: Date.now() - t0,
      detail: `${nodes.size} nodes, ${traceEdges.length} edges (${traceEdges.filter((e) => e.type === "EXPLAINS_AYAH").length} EXPLAINS_AYAH, ${traceEdges.filter((e) => e.type === "CITES_AYAH").length} CITES_AYAH)`,
    });

    // ---------- Stage 3 input: the context ----------
    t0 = Date.now();
    const context: ContextNode[] = [];
    const ordered = [...nodes.values()]
      .filter((n) => n.type !== "Surah")
      .sort((a, b) => a.hop - b.hop || (b.score || 0) - (a.score || 0));
    for (const n of ordered) {
      const r = records.get(n.id)!,
        s = sources[n.id];
      const nodeNotes: string[] = [];
      let body = "";
      switch (n.type) {
        case "Ayah": {
          const t = tafsirFor.get(n.id);
          body = [
            `Surah ${r.surah_name_en} (${r.surah_name_ar}), ${r.revelation_place}, ayah ${r.ayah_key}.`,
            `PRIMARY TEXT (immutable; present only with {{quote:${n.id}}}):`,
            `EN (Sahih International): ${r.translation_en}`,
            opts.lang === "de" ? `DE (Bubenheim & Elyas): ${r.translation_de}` : "",
            opts.lang === "ar" || persona === "scholar" ? `AR: ${r.text_uthmani}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          if (t)
            nodeNotes.push(
              t.coverage === "passage"
                ? `Explained within the passage commentary ${t.from}.`
                : `Explained by ${t.from}.`,
            );
          else nodeNotes.push("No classical Tafsir node exists for this ayah in Ring 1; do not attribute an explanation to Ibn Kathir.");
          break;
        }
        case "TafsirEntry": {
          const covers = traceEdges.filter((e) => e.from === n.id && e.type === "EXPLAINS_AYAH").map((e) => e.to);
          body = `Ibn Kathir (Tafsir al-Qur'an al-'Azim, abridged English), commentary at ${r.ayah_key}${covers.length ? `, covering ${covers.join(", ")}` : ""}. Excerpt:\n${excerpts.get(n.id) || ""}`;
          break;
        }
        case "HadeethEncItem":
          body = [
            `Title: ${s.title}`,
            `PRIMARY TEXT (immutable; present only with {{quote:${n.id}}}):`,
            `EN: ${r.matn_en}`,
            opts.lang === "de" && r.matn_de ? `DE: ${r.matn_de}` : "",
            opts.lang === "ar" || persona === "scholar" ? `AR: ${r.matn_ar}` : "",
            `Grade: ${s.grade?.label} (HadeethEnc). Reported by: ${r.attribution_en}.`,
            `Explanation (Sharh, ${s.commentaryLang}): ${clip(s.commentary || "", lim.sharhChars)}`,
            s.benefits?.length ? `Benefits (Fawa'id): ${s.benefits.slice(0, 5).map((b) => "• " + b).join(" ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          break;
        case "CanonicalHadith":
          body = [
            `${s.title}, book ${r.book_number}.`,
            `PRIMARY TEXT (immutable; present only with {{quote:${n.id}}}):`,
            `EN: ${clip(r.matn_en, 1600)}`,
            opts.lang === "ar" || persona === "scholar" ? `AR: ${clip(r.matn_ar, 1200)}` : "",
            `Grade: ${s.grade?.label}${s.grade?.basis === "collection" ? " — status of the collection; no individual grading in the source" : s.grade?.basis === "unknown" ? " — not graded in the source; do not assert a grade" : ""}.`,
            "No Sharh for this hadith in Ring 1.",
          ]
            .filter(Boolean)
            .join("\n");
          break;
        case "Category":
          body = `HadeethEnc subject category: ${r.name}.`;
          break;
      }
      context.push({ id: n.id, type: n.type, hop: n.hop, label: s.title, body, notes: nodeNotes });
    }
    stages.push({ name: "Grounded context", ms: Date.now() - t0, detail: `${context.length} context nodes for synthesis` });

    return {
      searchLang,
      sources,
      context,
      trace: {
        query: opts.question,
        lang: searchLang,
        stages,
        nodes: [...nodes.values()],
        edges: traceEdges,
        vector: !!semantic,
        notes,
      },
    };
  }

  // Verbatim records for saved node ids (to reopen a saved answer).
  async sources(ids: string[], lang: Lang): Promise<Record<string, SourceNode>> {
    if (!ids.length) return {};
    const types = await this.corpus.query("SELECT node_id, node_type FROM mihrab_nodes WHERE node_id = ANY($ids)", {
      ids: this.corpus.ids([...new Set(ids)]),
    });
    const out: Record<string, SourceNode> = {};
    for (const [type, list] of groupBy(types, "node_type"))
      for (const [id, r] of await this.records(list.map((x) => x.node_id as string), type as NodeType))
        out[id] = toSource(type as NodeType, r, lang);
    return out;
  }

  async node(id: string, lang: Lang): Promise<{ source: SourceNode; neighbors: TraceEdge[] } | null> {
    const [row] = await this.corpus.query(`SELECT node_type FROM mihrab_nodes WHERE node_id = $id`, { id });
    if (!row) return null;
    const type = row.node_type as NodeType;
    const r = (await this.records([id], type)).get(id)!;
    const neighbors = (
      await this.corpus.query(
        `SELECT source_id, target_id, edge_type, coverage FROM mihrab_edges WHERE source_id = $id OR target_id = $id LIMIT 60`,
        { id },
      )
    ).map((e) => ({ from: e.source_id, to: e.target_id, type: e.edge_type, coverage: e.coverage }));
    return { source: toSource(type, r, lang), neighbors };
  }
}

function groupBy<T extends Record<string, any>>(rows: T[], key: keyof T) {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r[key], [...(m.get(r[key]) || []), r]);
  return m;
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + " […]" : s);
