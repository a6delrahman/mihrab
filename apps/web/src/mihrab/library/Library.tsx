// The Library: Ring 1's sources as books. A shelf, and a reader with a
// contents sidebar, progress, bookmarks, in-book search and "ask about this".
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  Bookmark as BookmarkIcon,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ListTree,
  Maximize,
  MessageCircleQuestion,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import type {
  BookId,
  Lang,
  LibraryBook,
  LibraryChapter,
  LibraryItem,
  LibraryPage,
  SourceNode,
} from "../../../../../packages/shared/src/mihrab";
import { readStorage, writeStorage } from "../../kit/util";
import { fetchBooks, fetchChapter, searchBook } from "../api";
import type { Strings } from "../i18n";
import { GradeBadge } from "../sources";
import { VoiceButton } from "../voice";
import {
  readBookmarks,
  readLastRead,
  readProgress,
  recordLastRead,
  recordSeen,
  toggleBookmark,
  useStore,
} from "./store";
import "./library.css";

type Props = { lang: Lang; t: Strings; onAsk: (question: string) => void };
// Rough reading time per item, for "approx. N left".
const SECONDS: Record<BookId, number> = { quran: 20, "tafsir-ibn-kathir": 150, hadeethenc: 110, bukhari: 35, muslim: 35, nawawi40: 60 };
const arabicDigits = (n: string | number) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);

function bookShare(book: LibraryBook, progress: Record<string, number> = {}) {
  const read = book.chapters.reduce((n, c) => n + c.count * (progress[c.id] || 0), 0);
  return book.total ? read / book.total : 0;
}
function timeLeft(book: LibraryBook, share: number, t: Strings) {
  const s = book.total * (1 - share) * SECONDS[book.id];
  return t.hoursLeft(s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.round(s / 3600)} h`);
}

export function Cover({ book, size = "md" }: { book: Pick<LibraryBook, "id" | "title" | "titleAr">; size?: "sm" | "md" }) {
  return (
    <div className={`mh-cover is-${size}`} data-book={book.id} aria-hidden>
      <svg className="mh-cover__arch" viewBox="0 0 100 130" preserveAspectRatio="xMidYMid meet">
        <path d="M14 128V58C14 30 32 14 50 4c18 10 36 26 36 54v70" />
        <path d="M28 128V64c0-17 10-28 22-35 12 7 22 18 22 35v64" />
        <path d="M40 128V72c0-9 5-15 10-19 5 4 10 10 10 19v56" />
      </svg>
      <span className="mh-cover__ar" lang="ar">
        {book.titleAr}
      </span>
      <span className="mh-cover__en">{book.title}</span>
    </div>
  );
}

function Shelf({ lang, t }: Props) {
  const navigate = useNavigate();
  const books = useQuery({ queryKey: ["mihrab-books", lang], queryFn: () => fetchBooks(lang), staleTime: Infinity });
  const progress = useStore(readProgress);
  const last = useStore(readLastRead);
  return (
    <div className="mh-shelf">
      <header className="mh-shelf__head">
        <h1>{t.libraryTitle}</h1>
        <p>{t.libraryIntro}</p>
      </header>
      {books.error && <p className="mh-error">{String((books.error as Error).message)}</p>}
      <div className="mh-shelf__grid">
        {(books.data || []).map((b) => {
          const share = bookShare(b, progress[b.id]);
          const resume = last[b.id];
          const resumeChapter = resume && b.chapters.find((c) => c.id === resume.chapter);
          return (
            <article key={b.id} className="mh-book">
              <button type="button" className="mh-book__cover" onClick={() => navigate(`/mihrab/library/${b.id}`)} aria-label={b.title}>
                <Cover book={b} />
              </button>
              <div className="mh-book__body">
                <h2>{b.title}</h2>
                <p className="mh-book__author">{b.author}</p>
                <p className="mh-book__desc">{b.description}</p>
                <p className="mh-book__meta">
                  {b.chapters.length} {b.chapterLabel.toLowerCase()} · {b.total.toLocaleString()}
                </p>
                <div className="mh-progress" aria-label={`${Math.round(share * 100)}% ${t.complete}`}>
                  <span style={{ width: `${Math.max(share * 100, share ? 2 : 0)}%` }} />
                </div>
                <div className="mh-book__actions">
                  <span>
                    {Math.round(share * 100)}% {t.complete}
                  </span>
                  <button
                    type="button"
                    className="mh-btn"
                    onClick={() =>
                      navigate(
                        `/mihrab/library/${b.id}` +
                          (resumeChapter ? `/${resumeChapter.id}${resume.node ? `?at=${encodeURIComponent(resume.node)}` : ""}` : ""),
                      )
                    }
                  >
                    {resumeChapter ? `${t.continueReading} · ${resumeChapter.title}` : t.startReading}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ---------- reading items ----------
function ItemActions(props: { source: SourceNode; book: string; chapter: string; t: Strings; onAsk: (q: string) => void }) {
  const marks = useStore(readBookmarks);
  const marked = marks.some((m) => m.id === props.source.node_id);
  return (
    <div className="mh-read-actions">
      <button
        type="button"
        title={marked ? props.t.unbookmark : props.t.bookmark}
        aria-label={marked ? props.t.unbookmark : props.t.bookmark}
        aria-pressed={marked}
        onClick={() => toggleBookmark({ id: props.source.node_id, book: props.book, chapter: props.chapter, title: props.source.title })}
      >
        {marked ? <BookmarkCheck size={15} /> : <BookmarkIcon size={15} />}
      </button>
      <button type="button" title={props.t.askAbout} aria-label={props.t.askAbout} onClick={() => props.onAsk(props.t.explainPrompt(props.source.title))}>
        <MessageCircleQuestion size={15} />
      </button>
    </div>
  );
}

const Arabic = ({ text, ayah }: { text?: string; ayah?: string }) =>
  text ? (
    <p className="mh-read-arabic" lang="ar" dir="rtl">
      {text}
      {ayah && <span className="mh-ayah-no"> ﴿{arabicDigits(ayah)}﴾</span>}
    </p>
  ) : null;
function translationOf(s: SourceNode, lang: Lang) {
  return lang === "de" && s.translation?.de ? s.translation.de : s.translation?.en;
}
// Commentary paragraphs; short unpunctuated lines are the source's headings,
// and paragraphs that are mostly Arabic are quotations.
function Prose({ text, lang }: { text: string; lang: string }) {
  return (
    <div className="mh-read-prose" lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
      {text.split(/\n+/).map((para, i) => {
        const arabic = lang !== "ar" && para.replace(/[^؀-ۿ]/g, "").length > para.length * 0.5;
        if (arabic)
          return (
            <p key={i} className="mh-read-arabic is-quote" lang="ar" dir="rtl">
              {para}
            </p>
          );
        if (para.length < 90 && !/[.!?:;,)»"”]$/.test(para.trim())) return <h4 key={i}>{para}</h4>;
        return <p key={i}>{para}</p>;
      })}
    </div>
  );
}

function ReadingItem(props: { item: LibraryItem; book: BookId; chapter: string; lang: Lang; showArabic: boolean; t: Strings; onAsk: (q: string) => void }) {
  const { item, lang, t, showArabic } = props;
  const s = item.source;
  const actions = <ItemActions source={s} book={props.book} chapter={props.chapter} t={t} onAsk={props.onAsk} />;
  const ar = showArabic || lang === "ar";
  const tr = translationOf(s, lang);
  switch (s.type) {
    case "Ayah": {
      const n = String(s.meta.ayah_key).split(":")[1];
      return (
        <article className="mh-read-item is-ayah" id={`n-${s.node_id}`} data-node={s.node_id}>
          {actions}
          {ar && <Arabic text={s.arabic} ayah={n} />}
          {lang !== "ar" && (
            <p className="mh-read-translation" dir="ltr">
              <span className="mh-ayah-badge">{n}</span>
              {tr}
            </p>
          )}
        </article>
      );
    }
    case "TafsirEntry":
      return (
        <article className="mh-read-item is-tafsir" id={`n-${s.node_id}`} data-node={s.node_id}>
          {actions}
          <p className="mh-read-kicker">
            {t.coversAyahs} {item.ayahs?.map((a) => String(a.meta.ayah_key)).join(", ") || String(s.meta.ayah_key)}
          </p>
          {!!item.ayahs?.length && (
            <div className="mh-read-verses">
              {item.ayahs.map((a) => (
                <div key={a.node_id} className="mh-read-verse" id={`n-${a.node_id}`}>
                  {ar && <Arabic text={a.arabic} ayah={String(a.meta.ayah_key).split(":")[1]} />}
                  {lang !== "ar" && (
                    <p className="mh-read-translation is-small" dir="ltr">
                      <span className="mh-ayah-badge">{String(a.meta.ayah_key)}</span>
                      {translationOf(a, lang)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <Prose text={s.commentary || ""} lang="en" />
        </article>
      );
    case "HadeethEncItem":
      return (
        <article className="mh-read-item is-hadith" id={`n-${s.node_id}`} data-node={s.node_id}>
          {actions}
          <h3 className="mh-read-title" dir="auto">
            {s.title}
          </h3>
          <div className="mh-read-badges">{s.grade && <GradeBadge grade={s.grade} />}</div>
          <Arabic text={s.arabic} />
          {lang !== "ar" && (
            <p className="mh-read-translation" dir="ltr">
              {tr}
            </p>
          )}
          {s.attribution && <p className="mh-read-attribution">{t.attribution}: {s.attribution}</p>}
          {s.commentary && (
            <section>
              <h4 className="mh-read-section">{t.sharh}</h4>
              {s.commentaryLang !== lang && <p className="mh-muted">{t.fallbackLang}</p>}
              <Prose text={s.commentary} lang={s.commentaryLang || "en"} />
            </section>
          )}
          {!!s.benefits?.length && (
            <section>
              <h4 className="mh-read-section">{t.benefits}</h4>
              <ul className="mh-benefits" dir="ltr">
                {s.benefits.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </section>
          )}
        </article>
      );
    default:
      return (
        <article className="mh-read-item is-hadith" id={`n-${s.node_id}`} data-node={s.node_id}>
          {actions}
          <h3 className="mh-read-title">{s.title}</h3>
          <div className="mh-read-badges">{s.grade && <GradeBadge grade={s.grade} />}</div>
          <Arabic text={s.arabic} />
          {lang !== "ar" || !s.arabic ? (
            <p className="mh-read-translation" dir="ltr">
              {s.translation?.en}
            </p>
          ) : null}
        </article>
      );
  }
}

// ---------- reader ----------
function Reader({ lang, t, onAsk }: Props) {
  const { book: bookId = "", chapter: chapterParam } = useParams();
  const [params] = useSearchParams();
  const at = params.get("at") || undefined;
  const navigate = useNavigate();
  const books = useQuery({ queryKey: ["mihrab-books", lang], queryFn: () => fetchBooks(lang), staleTime: Infinity });
  const book = books.data?.find((b) => b.id === bookId);
  const progress = useStore(readProgress);
  const last = useStore(readLastRead);
  const marks = useStore(readBookmarks);
  const chapterId = chapterParam || last[bookId]?.chapter || book?.chapters[0]?.id;

  const [pages, setPages] = useState<LibraryPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(() => readStorage("mihrab.reader.sidebar", "open") !== "closed");
  const [tab, setTab] = useState<"contents" | "bookmarks">("contents");
  const [panel, setPanel] = useState<null | "ask" | "search" | "settings">(null);
  const [size, setSize] = useState(() => Number(readStorage("mihrab.reader.size", "1")) || 1);
  const [showArabic, setShowArabic] = useState(() => readStorage("mihrab.reader.arabic", "1") === "1");
  const [question, setQuestion] = useState("");
  const [query, setQuery] = useState("");
  const main = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const tocActive = useRef<HTMLLIElement>(null);
  const askField = useRef<HTMLTextAreaElement>(null);
  // While jumping to a passage, what scrolls past does not count as read.
  const settled = useRef(true);
  useEffect(() => {
    if (panel === "ask") askField.current?.focus({ preventScroll: true });
  }, [panel]);

  useEffect(() => {
    writeStorage("mihrab.reader.sidebar", sidebar ? "open" : "closed");
  }, [sidebar]);
  useEffect(() => {
    writeStorage("mihrab.reader.size", String(size));
  }, [size]);
  useEffect(() => {
    writeStorage("mihrab.reader.arabic", showArabic ? "1" : "0");
  }, [showArabic]);

  // Load the chapter (at the page holding `at`, when given).
  useEffect(() => {
    if (!book || !chapterId) return;
    let live = true;
    setLoading(true);
    setError(null);
    settled.current = !at;
    fetchChapter(book.id, chapterId, lang, { around: at })
      .then((p) => {
        if (!live) return;
        setPages([p]);
        if (!at) main.current?.scrollTo({ top: 0 });
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [book?.id, chapterId, lang, at]);

  // Bring the requested passage into view and mark it briefly.
  useLayoutEffect(() => {
    if (!at || !pages.length) return;
    const el = document.getElementById(`n-${at}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    settled.current = true;
    el.classList.add("is-target");
    const timer = setTimeout(() => el.classList.remove("is-target"), 2600);
    return () => clearTimeout(timer);
  }, [pages, at]);
  useEffect(() => {
    tocActive.current?.scrollIntoView({ block: "nearest" });
  }, [chapterId, sidebar, tab]);

  const first = pages[0],
    lastPage = pages.at(-1);
  const items = useMemo(() => pages.flatMap((p) => p.items.map((item, i) => ({ item, index: p.offset + i }))), [pages]);
  const loadedEnd = lastPage ? lastPage.offset + lastPage.items.length : 0;
  const pageSize = first?.items.length || 1;

  const loadMore = useCallback(async () => {
    if (!book || !chapterId || !lastPage || loadedEnd >= lastPage.total || loading) return;
    setLoading(true);
    try {
      const p = await fetchChapter(book.id, chapterId, lang, { offset: loadedEnd });
      setPages((all) => [...all, p]);
    } finally {
      setLoading(false);
    }
  }, [book?.id, chapterId, lang, lastPage, loadedEnd, loading]);
  async function loadEarlier() {
    if (!book || !chapterId || !first || !first.offset) return;
    const offset = Math.max(0, first.offset - pageSize);
    const el = main.current,
      before = el ? el.scrollHeight - el.scrollTop : 0;
    const p = await fetchChapter(book.id, chapterId, lang, { offset });
    p.items = p.items.slice(0, first.offset - offset);
    setPages((all) => [p, ...all]);
    // Keep the passage being read where it is.
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - before));
  }

  // Progress: how far through the chapter the reader has scrolled.
  const onScroll = useCallback(() => {
    const el = main.current;
    if (!el || !book || !chapterId || !lastPage || !settled.current) return;
    const box = el.getBoundingClientRect();
    const nodes = el.querySelectorAll<HTMLElement>(".mh-read-item");
    // Items with some part on screen count as seen.
    let firstVisible = -1,
      lastVisible = -1;
    nodes.forEach((n, i) => {
      const r = n.getBoundingClientRect();
      if (r.bottom > box.top + 60 && r.top < box.bottom - 60) {
        if (firstVisible < 0) firstVisible = i;
        lastVisible = i;
      }
    });
    if (firstVisible >= 0) {
      recordSeen(book.id, chapterId, items[firstVisible].index, items[lastVisible].index, lastPage.total);
      recordLastRead(book.id, chapterId, items[firstVisible].item.source.node_id);
    }
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) void loadMore();
  }, [book?.id, chapterId, items, lastPage, loadMore]);
  useEffect(() => {
    const id = setTimeout(onScroll, 400);
    return () => clearTimeout(id);
  }, [items]);

  const search = useQuery({
    queryKey: ["mihrab-book-search", bookId, lang, query],
    queryFn: () => searchBook(bookId, query, lang),
    enabled: panel === "search" && query.trim().length > 1,
    staleTime: 60_000,
  });

  if (books.isPending) return <p className="mh-empty-pane">…</p>;
  if (!book)
    return (
      <p className="mh-empty-pane">
        {books.error ? String((books.error as Error).message) : "Book not found"} · <a href="/mihrab/library">{t.backToLibrary}</a>
      </p>
    );
  const chapter = book.chapters.find((c) => c.id === chapterId) || book.chapters[0];
  const index = book.chapters.indexOf(chapter);
  const prev = book.chapters[index - 1],
    next = book.chapters[index + 1];
  const share = bookShare(book, progress[book.id]);
  const go = (c: LibraryChapter, node?: string) => navigate(`/mihrab/library/${book.id}/${c.id}${node ? `?at=${encodeURIComponent(node)}` : ""}`);
  const chapterName = `${book.chapterLabel} ${chapter.number} · ${chapter.title}`;
  const sendQuestion = (q: string) => {
    if (!q.trim()) return;
    setQuestion("");
    setPanel(null);
    onAsk(q.trim());
  };

  return (
    <div className={`mh-reader${sidebar ? "" : " is-collapsed"}`} ref={root} style={{ ["--mh-read-scale" as string]: size }}>
      <div className="mh-reader__main" ref={main} onScroll={onScroll}>
        <div className="mh-reader__column">
          <div className="mh-reader__top">
            <button type="button" className="mh-summarize" onClick={() => sendQuestion(t.summarizePrompt(chapterName, book.title))}>
              <Sparkles size={15} /> {t.summarize}
            </button>
            <a className="mh-linklike" href="/mihrab/library" onClick={(e) => (e.preventDefault(), navigate("/mihrab/library"))}>
              {t.backToLibrary}
            </a>
          </div>
          {panel === "ask" && (
            <form
              className="mh-reader__ask"
              onSubmit={(e) => {
                e.preventDefault();
                sendQuestion(question);
              }}
            >
              <textarea
                ref={askField}
                value={question}
                rows={2}
                dir="auto"
                placeholder={t.askPlaceholder}
                aria-label={t.askPlaceholder}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendQuestion(question);
                  }
                }}
              />
              <VoiceButton value={question} onChange={setQuestion} lang={lang} t={t} />
              <button type="submit" className="mh-send" disabled={!question.trim()} aria-label={t.ask}>
                <ArrowUp size={18} />
              </button>
            </form>
          )}
          <header className="mh-chapter-head">
            <p className="mh-chapter-head__label">
              {book.chapterLabel} {chapter.number}
            </p>
            <h1>{chapter.title}</h1>
            {chapter.titleAr && (
              <p className="mh-chapter-head__ar" lang="ar" dir="rtl">
                {chapter.titleAr}
              </p>
            )}
            {chapter.subtitle && <p className="mh-chapter-head__sub">{chapter.subtitle}</p>}
          </header>
          {error && <p className="mh-error">{error}</p>}
          {first && first.offset > 0 && (
            <button type="button" className="mh-btn is-quiet mh-load" onClick={loadEarlier}>
              <ChevronUp size={15} /> {t.loadEarlier}
            </button>
          )}
          {items.map(({ item }) => (
            <ReadingItem key={item.source.node_id} item={item} book={book.id} chapter={chapter.id} lang={lang} showArabic={showArabic} t={t} onAsk={sendQuestion} />
          ))}
          {lastPage && loadedEnd < lastPage.total && (
            <button type="button" className="mh-btn is-quiet mh-load" onClick={loadMore} disabled={loading}>
              {loading ? "…" : `${t.loadMore} (${loadedEnd}/${lastPage.total})`}
            </button>
          )}
          {lastPage && loadedEnd >= lastPage.total && next && (
            <button type="button" className="mh-next-chapter" onClick={() => go(next)}>
              <span>{t.nextChapter}</span>
              <strong>
                {book.chapterLabel} {next.number} · {next.title}
              </strong>
            </button>
          )}
        </div>

        <div className="mh-reader__tools" role="toolbar" aria-label={t.readerSettings}>
          <button type="button" title={t.askChapter} aria-label={t.askChapter} aria-pressed={panel === "ask"} className="is-sparkle" onClick={() => setPanel(panel === "ask" ? null : "ask")}>
            <Sparkles size={18} />
          </button>
          <button type="button" title={t.contents} aria-label={t.contents} aria-pressed={sidebar} className={sidebar ? "is-on" : ""} onClick={() => setSidebar(!sidebar)}>
            <ListTree size={18} />
          </button>
          <button
            type="button"
            title={t.searchBook}
            aria-label={t.searchBook}
            aria-pressed={panel === "search"}
            onClick={() => {
              setSidebar(true);
              setPanel(panel === "search" ? null : "search");
            }}
          >
            <Search size={18} />
          </button>
          <div className="mh-reader__tools-end">
            <button type="button" title={t.readerSettings} aria-label={t.readerSettings} aria-pressed={panel === "settings"} onClick={() => setPanel(panel === "settings" ? null : "settings")}>
              <Settings2 size={18} />
            </button>
            <button
              type="button"
              title={t.focus}
              aria-label={t.focus}
              onClick={() => (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen?.())}
            >
              <Maximize size={18} />
            </button>
          </div>
          {panel === "settings" && (
            <div className="mh-popover" role="dialog" aria-label={t.readerSettings}>
              <p>{t.textSize}</p>
              <div className="mh-seg">
                {[0.9, 1, 1.15, 1.3].map((v, i) => (
                  <button key={v} type="button" className={size === v ? "is-on" : ""} onClick={() => setSize(v)} style={{ fontSize: 12 + i * 2 }}>
                    A
                  </button>
                ))}
              </div>
              <label className="mh-check">
                <input type="checkbox" checked={showArabic || lang === "ar"} disabled={lang === "ar"} onChange={(e) => setShowArabic(e.target.checked)} /> {t.showArabic}
              </label>
            </div>
          )}
        </div>

        <nav className="mh-reader__bar" aria-label={chapterName}>
          <button type="button" disabled={!prev} onClick={() => prev && go(prev)} aria-label={t.prevChapter} title={prev ? `${t.prevChapter}: ${prev.title}` : ""}>
            <ChevronLeft size={18} className="mh-flip" />
          </button>
          <button type="button" className="mh-reader__bar-title" onClick={() => setSidebar(!sidebar)}>
            <strong>{chapterName}</strong>
            <span>{book.title}</span>
          </button>
          <button type="button" disabled={!next} onClick={() => next && go(next)} aria-label={t.nextChapter} title={next ? `${t.nextChapter}: ${next.title}` : ""}>
            <ChevronRight size={18} className="mh-flip" />
          </button>
        </nav>
      </div>

      {sidebar && (
        <aside className="mh-reader__side" aria-label={t.contents}>
          <button type="button" className="mh-reader__close" aria-label={t.collapse} title={t.collapse} onClick={() => setSidebar(false)}>
            <X size={18} />
          </button>
          <div className="mh-reader__book">
            <Cover book={book} size="sm" />
            <div>
              <h2>{book.title}</h2>
              <p className="mh-book__author">{book.author}</p>
            </div>
          </div>
          <div className="mh-progress">
            <span style={{ width: `${Math.max(share * 100, share ? 2 : 0)}%` }} />
          </div>
          <p className="mh-reader__stat">
            <strong>
              {Math.round(share * 100)}% {t.complete}
            </strong>
            <span>{timeLeft(book, share, t)}</span>
          </p>
          {panel === "search" && (
            <div className="mh-reader__search">
              <form className="mh-search-field" onSubmit={(e) => e.preventDefault()}>
                <Search size={15} aria-hidden />
                <input value={query} dir="auto" autoFocus placeholder={t.searchBook} aria-label={t.searchBook} onChange={(e) => setQuery(e.target.value)} />
                <VoiceButton value={query} onChange={setQuery} lang={lang} t={t} />
              </form>
              {search.data && !search.data.length && <p className="mh-muted">{t.noResults}</p>}
              <ul className="mh-hits">
                {(search.data || []).map((h) => (
                  <li key={h.node_id}>
                    <button
                      type="button"
                      onClick={() => {
                        const c = book.chapters.find((x) => x.id === h.chapter);
                        if (c) go(c, h.node_id);
                      }}
                    >
                      <strong>{h.title}</strong>
                      <span dir="auto">{h.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mh-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "contents"} className={tab === "contents" ? "is-on" : ""} onClick={() => setTab("contents")}>
              {t.contents}
            </button>
            <button role="tab" aria-selected={tab === "bookmarks"} className={tab === "bookmarks" ? "is-on" : ""} onClick={() => setTab("bookmarks")}>
              {t.bookmarks}
            </button>
          </div>
          {tab === "contents" ? (
            <ol className="mh-toc">
              {book.chapters.map((c) => {
                const p = progress[book.id]?.[c.id] || 0;
                const on = c.id === chapter.id;
                return (
                  <li key={c.id} ref={on ? tocActive : undefined} className={on ? "is-on" : ""}>
                    <button type="button" onClick={() => go(c)}>
                      <span className="mh-toc__title">
                        {c.number}. {c.title}
                        {c.titleAr && (
                          <span className="mh-toc__ar" lang="ar">
                            {c.titleAr}
                          </span>
                        )}
                      </span>
                      {(p > 0 || on) && (
                        <span className="mh-toc__pct">
                          {Math.round(p * 100)}% {t.complete}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <ul className="mh-toc">
              {marks.filter((m) => m.book === book.id).length === 0 && <li className="mh-muted">{t.noBookmarks}</li>}
              {marks
                .filter((m) => m.book === book.id)
                .map((m) => {
                  const c = book.chapters.find((x) => x.id === m.chapter);
                  return (
                    <li key={m.id}>
                      <button type="button" onClick={() => c && go(c, m.id)}>
                        <span className="mh-toc__title">{m.title}</span>
                        {c && <span className="mh-toc__pct">{c.title}</span>}
                      </button>
                    </li>
                  );
                })}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}

export function Library(props: Props) {
  return (
    <div className="mh-library">
      <Routes>
        {/* Relative to Mihrab's own route, /mihrab/*. */}
        <Route path="library" element={<Shelf {...props} />} />
        <Route path="library/:book" element={<Reader {...props} />} />
        <Route path="library/:book/:chapter" element={<Reader {...props} />} />
      </Routes>
    </div>
  );
}
