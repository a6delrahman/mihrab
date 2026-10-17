// Mihrab: the Ring 1 ontology and the contract between its API and web app.
// Import values only from "zod" here; index.ts does not re-export this file.
import { z } from "zod";

export const LANGS = ["en", "de", "ar"] as const;
export type Lang = (typeof LANGS)[number];
export const PERSONAS = ["explorer", "scholar"] as const;
export type Persona = (typeof PERSONAS)[number];
export const PROVIDERS = ["azure_foundry", "ollama"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

// ---------- Ontology ----------
export type NodeType =
  | "Surah"
  | "Ayah"
  | "TafsirEntry"
  | "HadeethEncItem"
  | "CanonicalHadith"
  | "Category";
export type EdgeType =
  | "BELONGS_TO_SURAH"
  | "EXPLAINS_AYAH"
  | "CITES_AYAH"
  | "IN_CATEGORY";

export const NODE_TYPES: Record<
  NodeType,
  {
    table: string;
    prefix: string;
    fields: string[];
    // Primary texts: served verbatim from the corpus by node_id, never
    // generated, paraphrased or "corrected" by a model.
    immutable: string[];
  }
> = {
  Surah: {
    table: "surahs",
    prefix: "surah",
    fields: ["node_id", "surah_number", "name_ar", "name_en", "name_translation_en", "revelation_place", "ayah_count"],
    immutable: [],
  },
  Ayah: {
    table: "quran_ayahs",
    prefix: "ayah",
    fields: ["node_id", "ayah_key", "surah_number", "ayah_number", "surah_name_ar", "surah_name_en", "revelation_place", "text_uthmani", "translation_en", "translation_de"],
    immutable: ["text_uthmani", "translation_en", "translation_de"],
  },
  TafsirEntry: {
    table: "tafsir_entries",
    prefix: "tafsir",
    fields: ["node_id", "ayah_key", "source_slug", "author_name", "language", "text_clean"],
    immutable: [],
  },
  HadeethEncItem: {
    table: "hadeethenc_items",
    prefix: "hadeethenc",
    fields: ["node_id", "hadeeth_id", "title_en", "title_ar", "title_de", "matn_ar", "matn_en", "matn_de", "attribution_en", "grade_en", "explanation_en", "explanation_ar", "explanation_de", "hints_benefits", "categories"],
    immutable: ["matn_ar", "matn_en", "matn_de"],
  },
  CanonicalHadith: {
    table: "canonical_hadiths",
    prefix: "hadith",
    fields: ["node_id", "collection", "hadith_number", "book_number", "matn_ar", "matn_en", "grades"],
    immutable: ["matn_ar", "matn_en"],
  },
  Category: {
    table: "categories",
    prefix: "category",
    fields: ["node_id", "name"],
    immutable: [],
  },
};
// The five tables the brief names as Ring 1's core.
export const CORE_TABLES = [
  "quran_ayahs",
  "tafsir_entries",
  "hadeethenc_items",
  "canonical_hadiths",
  "graph_edges",
] as const;

export const EDGE_TYPES: Record<EdgeType, { from: NodeType; to: NodeType }> = {
  BELONGS_TO_SURAH: { from: "Ayah", to: "Surah" },
  EXPLAINS_AYAH: { from: "TafsirEntry", to: "Ayah" },
  CITES_AYAH: { from: "TafsirEntry", to: "Ayah" },
  IN_CATEGORY: { from: "HadeethEncItem", to: "Category" },
};

const PREFIX_TYPE = Object.fromEntries(
  Object.entries(NODE_TYPES).map(([t, d]) => [d.prefix, t as NodeType]),
);
// A node id is "<prefix>:<rest>"; ids are produced by scripts/ingest_ring1.py.
export const NODE_ID = /^(ayah:\d{1,3}:\d{1,3}|tafsir:[a-z0-9_]+:\d{1,3}:\d{1,3}|hadeethenc:\d+|hadith:[a-z0-9]+:\d+|category:[a-z0-9_]+|surah:\d{1,3})$/;
export function nodeType(id: string): NodeType | undefined {
  return NODE_ID.test(id) ? PREFIX_TYPE[id.split(":")[0]] : undefined;
}

// Collection-level status for collections whose hadiths carry no
// per-hadith grade in the source data.
export const COLLECTIONS: Record<string, { name: string; status?: string }> = {
  bukhari: { name: "Sahih al-Bukhari", status: "Sahih (collection)" },
  muslim: { name: "Sahih Muslim", status: "Sahih (collection)" },
  nawawi40: { name: "Al-Arba'in an-Nawawiyyah" },
};

// ---------- Citations ----------
// The model cites with [node_id], sometimes several in one bracket
// ("[ayah:2:255; tafsir:ibn_kathir_en:2:255]"). Quotations of primary text
// are requested with {{quote:node_id}} on their own line, which the server
// and client replace with the verbatim corpus record.
const BRACKET = /\[([^\[\]\n]{3,240})\]/g;
export const QUOTE = /\{\{\s*quote\s*:\s*([a-z0-9_:]+)\s*\}\}/g;
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "cite"; ids: string[]; raw: string }
  | { kind: "quote"; id: string };
export function citationIds(raw: string) {
  const ids = raw
    .split(/[;,]\s*|\s+/)
    .map((s) => s.trim().replace(/^node_id\s*[:=]\s*/i, ""))
    .filter(Boolean);
  return ids.length && ids.every((id) => NODE_ID.test(id)) ? ids : null;
}
// Splits text into prose, citation pills and quote cards. Unfinished
// markup at the end of a stream stays text until it completes.
export function segment(text: string): Segment[] {
  const out: Segment[] = [];
  const pattern = new RegExp(`${BRACKET.source}|${QUOTE.source}`, "g");
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index!;
    let seg: Segment | null = null;
    if (m[1] !== undefined) {
      const ids = citationIds(m[1]);
      if (ids) seg = { kind: "cite", ids, raw: m[0] };
    } else if (m[2] && NODE_ID.test(m[2])) seg = { kind: "quote", id: m[2] };
    if (!seg) continue;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push(seg);
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
export function citedIds(text: string) {
  const ids = new Set<string>();
  for (const s of segment(text))
    if (s.kind === "cite") s.ids.forEach((id) => ids.add(id));
    else if (s.kind === "quote") ids.add(s.id);
  return [...ids];
}

// ---------- Arabic normalisation (search only, never for display) ----------
// Strips tashkeel, Qur'anic annotation marks and tatweel, and folds letter
// variants, so "ٱلرَّحْمَٰنِ" and "الرحمن" match.
export function normalizeArabic(text: string) {
  return text
    .normalize("NFC")
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, "")
    .replace(/[آأإٱٲٳ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤ]/g, "و")
    .replace(/[ئ]/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}
// Function words that occur in only one of the two languages ("was", "in"
// and "die" are deliberately absent).
const DE_WORDS = new Set("und der das ist nicht wie warum ich ein eine einen über mit sie es auf für zu den dem des sind wird kann sagt gibt welche welcher wer wo im vom zum zur auch oder aber bei nach".split(" "));
const EN_WORDS = new Set("the is what who how why and of to a an about does are with for on that this which it from by can should tell".split(" "));
export function detectLang(text: string): Lang {
  const letters = text.replace(/[^\p{L}]/gu, "");
  const arabic = (letters.match(/[؀-ۿ]/g) || []).length;
  if (letters && arabic / letters.length > 0.4) return "ar";
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  const de = words.filter((w) => DE_WORDS.has(w)).length + (/[äöüß]/i.test(text) ? 1 : 0);
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  return de > en ? "de" : "en";
}

// Questions about one's own marriage, divorce, inheritance, oaths or
// similar call for a living scholar, not an answer engine.
const PERSONAL = /\b(i|i'm|my|me|mine|ich|mein|meine|meinem|meiner|mir|mich)\b|(?:^|\s)(أنا|زوجي|زوجتي|لي|علي)(?:\s|$)/i;
const RULING = /(divorc|talaq|ṭalāq|\bkhul|inherit|wasiyy|\bmy will\b|\bestate\b|\boath|\bvow|kaffar|nikah|nikāḥ|marri|wedding|husband|\bwife|custody|\bmahr\b|dowry|is it (?:haram|halal|allowed|permissible) for me|scheid|\berb(e|en|schaft|teil)|schwur|gelübde|\behe\b|heirat|ehemann|ehefrau|طلاق|خلع|ميراث|إرث|يمين|نذر|كفارة|نكاح|زواج|حضانة|مهر|وصية)/i;
export function isPersonalRuling(question: string) {
  return PERSONAL.test(question) && RULING.test(question);
}

// ---------- API contract ----------
export const AskSchema = z.object({
  question: z.string().trim().min(2).max(2000),
  // Continue a saved conversation; without it the answer starts a new one.
  conversationId: z.string().uuid().optional(),
  lang: z.enum(LANGS).optional(),
  persona: z.enum(PERSONAS).default("explorer"),
  provider: z.enum(PROVIDERS),
  model: z.string().min(1).max(200),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      }),
    )
    .max(8)
    .default([]),
});
export type AskRequest = z.input<typeof AskSchema>;

export type LlmModel = {
  provider: ProviderId;
  id: string;
  label: string;
  detail?: string;
};
export type LlmCatalog = {
  providers: {
    id: ProviderId;
    label: string;
    available: boolean;
    reason?: string;
    models: LlmModel[];
  }[];
  default: { provider: ProviderId; model: string } | null;
};

export type HadithGrade = {
  label: string;
  // "graded" when the source grades this hadith; "collection" when the
  // status comes from the collection; "unknown" when neither does.
  basis: "graded" | "collection" | "unknown";
  detail?: string;
};
export type SourceNode = {
  node_id: string;
  type: NodeType;
  title: string;
  // Verbatim primary text, straight from the corpus.
  arabic?: string;
  translation?: { en?: string; de?: string };
  grade?: HadithGrade;
  attribution?: string;
  // Commentary (Tafsir text or HadeethEnc Sharh) in the requested language
  // when the corpus has it, otherwise English.
  commentary?: string;
  commentaryLang?: Lang;
  benefits?: string[];
  meta: Record<string, string | number | null>;
};
export type TraceNode = {
  id: string;
  type: NodeType;
  label: string;
  hop: 0 | 1 | 2;
  score?: number;
  via?: string[];
};
export type TraceEdge = {
  from: string;
  to: string;
  type: EdgeType;
  coverage?: "direct" | "passage";
};
export type RetrievalTrace = {
  query: string;
  lang: Lang;
  stages: { name: string; ms: number; detail: string }[];
  nodes: TraceNode[];
  edges: TraceEdge[];
  vector: boolean;
  notes: string[];
};
export type AskEvent =
  | { type: "conversation"; id: string; title: string; created: boolean }
  | {
      type: "retrieval";
      trace: RetrievalTrace;
      sources: Record<string, SourceNode>;
      fatwaSensitive: boolean;
    }
  | { type: "phase"; phase: "reasoning" | "answering" }
  | { type: "token"; text: string }
  | {
      type: "done";
      usage: {
        promptTokens: number | null;
        completionTokens: number | null;
        latencyMs: number;
        firstTokenMs: number | null;
      };
      citations: { valid: string[]; unknown: string[] };
      // Primary text the model wrote into its prose instead of a source card.
      verbatim: { node_id: string; text: string }[];
      model: { provider: ProviderId; model: string };
    }
  | { type: "error"; message: string };

// ---------- Library (reading the sources) ----------
export const BOOK_IDS = ["quran", "tafsir-ibn-kathir", "hadeethenc", "bukhari", "muslim", "nawawi40"] as const;
export type BookId = (typeof BOOK_IDS)[number];
export type LibraryChapter = {
  id: string;
  number: number;
  title: string;
  titleAr?: string;
  subtitle?: string;
  count: number;
};
export type LibraryBook = {
  id: BookId;
  title: string;
  titleAr: string;
  author: string;
  description: string;
  chapterLabel: string;
  chapters: LibraryChapter[];
  total: number;
};
// One reading unit. A Tafsir passage carries the ayahs it covers, verbatim.
export type LibraryItem = {
  source: SourceNode;
  ayahs?: SourceNode[];
};
export type LibraryPage = {
  book: { id: BookId; title: string };
  chapter: LibraryChapter;
  items: LibraryItem[];
  offset: number;
  total: number;
  prev: LibraryChapter | null;
  next: LibraryChapter | null;
};
export type LibraryHit = {
  node_id: string;
  chapter: string;
  title: string;
  snippet: string;
};

// ---------- Chat history ----------
export type DoneInfo = Extract<AskEvent, { type: "done" }>;
export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  lang: Lang;
  persona: Persona;
};
export type ConversationTurn = {
  id: string;
  at: string;
  question: string;
  persona: Persona;
  lang: Lang;
  provider: ProviderId;
  model: string;
  answer: string;
  status: "done" | "error" | "stopped";
  error?: string;
  fatwaSensitive: boolean;
  trace: RetrievalTrace | null;
  done: DoneInfo | null;
  // Rebuilt from the corpus when the conversation is opened.
  sources: Record<string, SourceNode>;
};
export type Conversation = { summary: ConversationSummary; turns: ConversationTurn[] };
export const RenameSchema = z.object({ title: z.string().trim().min(1).max(120) });
