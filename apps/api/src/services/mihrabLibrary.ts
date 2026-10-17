// Mihrab's Library: the Ring 1 sources as books to read, chapter by chapter.
// Every text is served verbatim from the corpus (toSource), the same records
// answers cite.
import {
  normalizeArabic,
  type BookId,
  type Lang,
  type LibraryBook,
  type LibraryChapter,
  type LibraryHit,
  type LibraryItem,
  type LibraryPage,
  type NodeType,
} from "../../../../packages/shared/src/mihrab.js";
import { AppError } from "../security.js";
import type { MihrabCorpus, Row } from "./mihrabCorpus.js";
import { toSource } from "./mihrabRetriever.js";

type Meta = { title: Record<Lang, string>; titleAr: string; author: Record<Lang, string>; description: Record<Lang, string>; chapterLabel: Record<Lang, string> };
const BOOKS: Record<BookId, Meta> = {
  quran: {
    title: { en: "The Noble Qur'an", de: "Der edle Koran", ar: "القرآن الكريم" },
    titleAr: "القرآن الكريم",
    author: { en: "Uthmani script · Sahih International · Bubenheim & Elyas", de: "Uthmanische Schrift · Sahih International · Bubenheim & Elyas", ar: "الرسم العثماني · ترجمات صحيح إنترناشونال وبوبنهايم" },
    description: { en: "The 114 surahs with the Uthmani Arabic text and English and German translations.", de: "Die 114 Suren mit uthmanischem Text und englischer und deutscher Übersetzung.", ar: "السور المئة والأربع عشرة بالرسم العثماني مع الترجمتين الإنجليزية والألمانية." },
    chapterLabel: { en: "Surah", de: "Sure", ar: "سورة" },
  },
  "tafsir-ibn-kathir": {
    title: { en: "Tafsir Ibn Kathir", de: "Tafsir Ibn Kathir", ar: "تفسير ابن كثير" },
    titleAr: "تفسير القرآن العظيم",
    author: { en: "Hafiz Ibn Kathir · abridged English", de: "Hafiz Ibn Kathir · gekürzt, Englisch", ar: "الحافظ ابن كثير · مختصر بالإنجليزية" },
    description: { en: "Classical commentary, passage by passage, beside the verses it explains.", de: "Klassischer Kommentar, Abschnitt für Abschnitt, neben den erklärten Versen.", ar: "التفسير الكلاسيكي مقطعًا مقطعًا بجانب الآيات التي يفسرها." },
    chapterLabel: { en: "Surah", de: "Sure", ar: "سورة" },
  },
  hadeethenc: {
    title: { en: "Encyclopedia of Translated Hadiths", de: "Enzyklopädie übersetzter Hadithe", ar: "موسوعة الأحاديث النبوية" },
    titleAr: "موسوعة الأحاديث النبوية",
    author: { en: "HadeethEnc.com · graded, with explanation", de: "HadeethEnc.com · bewertet, mit Erläuterung", ar: "موسوعة الأحاديث · مخرّجة مع الشرح" },
    description: { en: "Hadiths with their grade, explanation (Sharh) and benefits, by subject.", de: "Hadithe mit Grad, Erläuterung (Scharh) und Nutzen, nach Themen.", ar: "أحاديث مع درجتها وشرحها وفوائدها، مرتبة حسب الموضوع." },
    chapterLabel: { en: "Subject", de: "Thema", ar: "الموضوع" },
  },
  bukhari: {
    title: { en: "Sahih al-Bukhari", de: "Sahih al-Bukhari", ar: "صحيح البخاري" },
    titleAr: "صحيح البخاري",
    author: { en: "Imam al-Bukhari", de: "Imam al-Bukhari", ar: "الإمام البخاري" },
    description: { en: "The collection, book by book, in Arabic and English.", de: "Die Sammlung, Buch für Buch, auf Arabisch und Englisch.", ar: "الجامع كتابًا كتابًا بالعربية والإنجليزية." },
    chapterLabel: { en: "Book", de: "Buch", ar: "كتاب" },
  },
  muslim: {
    title: { en: "Sahih Muslim", de: "Sahih Muslim", ar: "صحيح مسلم" },
    titleAr: "صحيح مسلم",
    author: { en: "Imam Muslim", de: "Imam Muslim", ar: "الإمام مسلم" },
    description: { en: "The collection, book by book, in Arabic and English.", de: "Die Sammlung, Buch für Buch, auf Arabisch und Englisch.", ar: "الصحيح كتابًا كتابًا بالعربية والإنجليزية." },
    chapterLabel: { en: "Book", de: "Buch", ar: "كتاب" },
  },
  nawawi40: {
    title: { en: "The Forty Hadith of an-Nawawi", de: "Die vierzig Hadithe von an-Nawawi", ar: "الأربعون النووية" },
    titleAr: "الأربعون النووية",
    author: { en: "Imam an-Nawawi", de: "Imam an-Nawawi", ar: "الإمام النووي" },
    description: { en: "The foundational forty-two hadiths, in Arabic and English.", de: "Die grundlegenden zweiundvierzig Hadithe auf Arabisch und Englisch.", ar: "الأحاديث الاثنان والأربعون الجامعة بالعربية والإنجليزية." },
    chapterLabel: { en: "Book", de: "Buch", ar: "كتاب" },
  },
};
const PAGE = { "tafsir-ibn-kathir": 12, hadeethenc: 25, bukhari: 40, muslim: 40, nawawi40: 50, quran: 300 } as const;
const isBook = (b: string): b is BookId => b in BOOKS;
const ayahOrder = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export class MihrabLibrary {
  private cache = new Map<string, LibraryBook>();
  constructor(private corpus: MihrabCorpus) {}

  async books(lang: Lang): Promise<LibraryBook[]> {
    const out = [];
    for (const id of Object.keys(BOOKS) as BookId[]) out.push(await this.book(id, lang));
    return out;
  }

  async book(id: string, lang: Lang): Promise<LibraryBook> {
    if (!isBook(id)) throw new AppError(404, "Book not found");
    const key = `${id}:${lang}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const m = BOOKS[id];
    const rows = await this.corpus.query(this.chaptersSql(id));
    const chapters: LibraryChapter[] = rows.map((r, i) => ({
      id: String(r.id),
      number: Number(r.number ?? i + 1),
      title: r.title,
      titleAr: r.title_ar || undefined,
      subtitle: r.subtitle || undefined,
      count: Number(r.count),
    }));
    const book: LibraryBook = {
      id,
      title: m.title[lang],
      titleAr: m.titleAr,
      author: m.author[lang],
      description: m.description[lang],
      chapterLabel: m.chapterLabel[lang],
      chapters,
      total: chapters.reduce((n, c) => n + c.count, 0),
    };
    this.cache.set(key, book);
    return book;
  }

  private chaptersSql(id: BookId) {
    switch (id) {
      case "quran":
        return `SELECT s.surah_number AS id, s.surah_number AS number, s.name_en AS title, s.name_ar AS title_ar,
                  s.name_translation_en || ' · ' || s.revelation_place AS subtitle, count(*) AS count
                FROM surahs s JOIN quran_ayahs a ON a.surah_number = s.surah_number
                GROUP BY s.surah_number, s.name_en, s.name_ar, s.name_translation_en, s.revelation_place
                ORDER BY s.surah_number`;
      case "tafsir-ibn-kathir":
        return `SELECT s.surah_number AS id, s.surah_number AS number, s.name_en AS title, s.name_ar AS title_ar,
                  s.name_translation_en AS subtitle, count(*) AS count
                FROM tafsir_entries t JOIN surahs s ON s.surah_number = CAST(split_part(t.ayah_key, ':', 1) AS INTEGER)
                GROUP BY ALL ORDER BY s.surah_number`;
      case "hadeethenc":
        return `SELECT replace(c.node_id, 'category:', '') AS id, CAST(c.hadeethenc_id AS INTEGER) AS number,
                  c.name AS title, count(e.source_id) AS count
                FROM categories c LEFT JOIN mihrab_edges e ON e.target_id = c.node_id AND e.edge_type = 'IN_CATEGORY'
                GROUP BY c.node_id, c.hadeethenc_id, c.name ORDER BY number`;
      default:
        return `SELECT b.book_number AS id, b.book_number AS number, b.name_en AS title, b.name_ar AS title_ar,
                  'Hadith ' || min(h.hadith_number) || '–' || max(h.hadith_number) AS subtitle, count(h.node_id) AS count
                FROM collection_books b JOIN mihrab_hadith_books h
                  ON h.collection = b.collection AND h.book_number = b.book_number
                WHERE b.collection = '${id}' GROUP BY b.book_number, b.name_en, b.name_ar ORDER BY b.book_number`;
    }
  }

  // The node ids of a chapter, in reading order.
  private async chapterIds(id: BookId, chapter: string): Promise<string[]> {
    const q = (sql: string, params: Record<string, unknown>) =>
      this.corpus.query(sql, params).then((r) => r.map((x) => x.node_id as string));
    switch (id) {
      case "quran":
        return q("SELECT node_id FROM quran_ayahs WHERE surah_number = $s ORDER BY ayah_number", { s: Number(chapter) });
      case "tafsir-ibn-kathir":
        return q(
          "SELECT node_id FROM tafsir_entries WHERE split_part(ayah_key, ':', 1) = $s ORDER BY CAST(split_part(ayah_key, ':', 2) AS INTEGER)",
          { s: String(Number(chapter)) },
        );
      case "hadeethenc":
        return q(
          `SELECT h.node_id FROM mihrab_edges e JOIN hadeethenc_items h ON h.node_id = e.source_id
           WHERE e.edge_type = 'IN_CATEGORY' AND e.target_id = $c ORDER BY CAST(h.hadeeth_id AS INTEGER)`,
          { c: "category:" + chapter },
        );
      default:
        return q(
          "SELECT node_id FROM mihrab_hadith_books WHERE collection = $col AND book_number = $b ORDER BY hadith_number",
          { col: id, b: Number(chapter) },
        );
    }
  }

  private async records(type: NodeType, table: string, ids: string[]) {
    if (!ids.length) return new Map<string, Row>();
    const rows = await this.corpus.query(`SELECT * FROM ${table} WHERE node_id = ANY($ids)`, { ids: this.corpus.ids(ids) });
    return new Map(rows.map((r) => [r.node_id as string, r]));
  }

  async chapter(
    bookId: string,
    chapterId: string,
    opts: { lang: Lang; offset?: number; limit?: number; around?: string },
  ): Promise<LibraryPage> {
    const book = await this.book(bookId, opts.lang);
    const index = book.chapters.findIndex((c) => c.id === chapterId);
    if (index < 0) throw new AppError(404, "Chapter not found");
    const id = book.id;
    const all = await this.chapterIds(id, chapterId);
    const limit = Math.min(opts.limit || PAGE[id], PAGE[id]);
    let offset = Math.max(0, opts.offset || 0);
    // Open the page that holds a given node (from search or a citation).
    if (opts.around) {
      const at = all.indexOf(opts.around);
      if (at >= 0) offset = Math.floor(at / limit) * limit;
    }
    const ids = all.slice(offset, offset + limit);
    let items: LibraryItem[];
    if (id === "quran") {
      const rows = await this.records("Ayah", "quran_ayahs", ids);
      items = ids.map((n) => ({ source: toSource("Ayah", rows.get(n)!, opts.lang) }));
    } else if (id === "tafsir-ibn-kathir") {
      const rows = await this.records("TafsirEntry", "tafsir_entries", ids);
      const covers = ids.length
        ? await this.corpus.query(
            "SELECT source_id, target_id FROM mihrab_edges WHERE edge_type = 'EXPLAINS_AYAH' AND source_id = ANY($ids)",
            { ids: this.corpus.ids(ids) },
          )
        : [];
      const ayahIds = [...new Set(covers.map((c) => c.target_id as string))];
      const ayahs = await this.records("Ayah", "quran_ayahs", ayahIds);
      items = ids.map((n) => ({
        source: toSource("TafsirEntry", rows.get(n)!, opts.lang),
        ayahs: covers
          .filter((c) => c.source_id === n && ayahs.has(c.target_id))
          .map((c) => c.target_id as string)
          .sort(ayahOrder)
          .map((a) => toSource("Ayah", ayahs.get(a)!, opts.lang)),
      }));
    } else if (id === "hadeethenc") {
      const rows = await this.records("HadeethEncItem", "hadeethenc_items", ids);
      items = ids.map((n) => ({ source: toSource("HadeethEncItem", rows.get(n)!, opts.lang) }));
    } else {
      const rows = await this.records("CanonicalHadith", "canonical_hadiths", ids);
      items = ids.map((n) => ({ source: toSource("CanonicalHadith", rows.get(n)!, opts.lang) }));
    }
    return {
      book: { id, title: book.title },
      chapter: book.chapters[index],
      items,
      offset,
      total: all.length,
      prev: book.chapters[index - 1] ?? null,
      next: book.chapters[index + 1] ?? null,
    };
  }

  // Keyword search within one book (the BM25 index of the reader's language).
  async search(bookId: string, query: string, lang: Lang): Promise<LibraryHit[]> {
    if (!isBook(bookId)) throw new AppError(404, "Book not found");
    const q = query.trim();
    if (q.length < 2) return [];
    const types: Record<BookId, string> = {
      quran: "Ayah",
      "tafsir-ibn-kathir": "TafsirEntry",
      hadeethenc: "HadeethEncItem",
      bukhari: "CanonicalHadith",
      muslim: "CanonicalHadith",
      nawawi40: "CanonicalHadith",
    };
    // Tafsir is English only; the collections have no German.
    const searchLang: Lang = bookId === "tafsir-ibn-kathir" || (types[bookId] === "CanonicalHadith" && lang === "de") ? "en" : lang;
    const t = `mihrab_search_${searchLang}`;
    const rows = await this.corpus.query(
      `SELECT c.node_id, any_value(c.text ORDER BY s.score DESC) AS text, max(s.score) AS score
       FROM (SELECT chunk_id, fts_main_${t}.match_bm25(chunk_id, $q) AS score FROM ${t}) s
       JOIN mihrab_chunks c USING (chunk_id)
       WHERE s.score IS NOT NULL AND c.node_type = $type AND ($prefix = '' OR c.node_id LIKE $prefix)
       GROUP BY c.node_id ORDER BY score DESC LIMIT 30`,
      {
        q: searchLang === "ar" ? normalizeArabic(q) : q,
        type: types[bookId],
        prefix: types[bookId] === "CanonicalHadith" ? `hadith:${bookId}:%` : "",
      },
    );
    const book = await this.book(bookId, lang);
    const hits: LibraryHit[] = [];
    for (const r of rows) {
      const chapter = await this.chapterOf(book, r.node_id);
      if (!chapter) continue;
      hits.push({ node_id: r.node_id, chapter: chapter.id, title: `${chapter.title} · ${label(r.node_id)}`, snippet: snippet(r.text, q) });
    }
    return hits;
  }

  // Where a node is read: its book and chapter.
  async locate(nodeId: string, lang: Lang): Promise<{ book: BookId; chapter: string } | null> {
    const [prefix, a] = nodeId.split(":");
    const bookId: BookId | undefined =
      prefix === "ayah" ? "quran" : prefix === "tafsir" ? "tafsir-ibn-kathir" : prefix === "hadeethenc" ? "hadeethenc" : prefix === "hadith" && isBook(a) ? (a as BookId) : undefined;
    if (!bookId) return null;
    const chapter = await this.chapterOf(await this.book(bookId, lang), nodeId);
    return chapter ? { book: bookId, chapter: chapter.id } : null;
  }

  private async chapterOf(book: LibraryBook, nodeId: string) {
    const parts = nodeId.split(":");
    if (book.id === "quran") return book.chapters.find((c) => c.id === parts[1]);
    if (book.id === "tafsir-ibn-kathir") return book.chapters.find((c) => c.id === parts[2]);
    if (book.id === "hadeethenc") {
      const [r] = await this.corpus.query(
        "SELECT replace(target_id, 'category:', '') AS c FROM mihrab_edges WHERE edge_type = 'IN_CATEGORY' AND source_id = $id LIMIT 1",
        { id: nodeId },
      );
      return r && book.chapters.find((c) => c.id === r.c);
    }
    const [r] = await this.corpus.query("SELECT book_number FROM mihrab_hadith_books WHERE node_id = $id", { id: nodeId });
    return r && book.chapters.find((c) => c.id === String(r.book_number));
  }
}

const label = (id: string) => {
  const p = id.split(":");
  return p[0] === "ayah" ? p.slice(1).join(":") : p[0] === "tafsir" ? p.slice(2).join(":") : p.at(-1)!;
};
// About 220 characters around the first matching word.
function snippet(text: string, q: string) {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const lower = text.toLowerCase();
  const found = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const start = Math.max(0, (found.length ? Math.min(...found) : 0) - 80);
  return (start ? "…" : "") + text.slice(start, start + 220).replace(/\s+/g, " ").trim() + (start + 220 < text.length ? "…" : "");
}
