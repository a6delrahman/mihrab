import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import type {
  Lang,
  SourceNode,
  TraceEdge,
} from "../../../../packages/shared/src/mihrab";
import { fetchNode } from "./api";
import type { Strings } from "./i18n";
import { GradeBadge, SourceCard, citationLabel, typeClass } from "./sources";

export function Inspector(props: {
  id: string | null;
  sources: Record<string, SourceNode>;
  lang: Lang;
  showArabic: boolean;
  onSelect: (id: string) => void;
  onOpenLibrary?: (id: string) => void;
  t: Strings;
}) {
  const { id, t } = props;
  // Always fetched, for the node's edges; the answer's own copy shows first.
  const q = useQuery({
    queryKey: ["mihrab-node", id, props.lang],
    queryFn: () => fetchNode(id!, props.lang),
    enabled: !!id,
    staleTime: Infinity,
    retry: false,
  });
  if (!id) return <p className="mh-empty-pane">{t.inspectorEmpty}</p>;
  const s = props.sources[id] || q.data?.source;
  if (!s)
    return q.isPending ? (
      <p className="mh-empty-pane">…</p>
    ) : (
      <p className="mh-empty-pane">
        <code className="mh-id">{id}</code> — {q.error ? String((q.error as Error).message) : t.notInContext}
      </p>
    );
  const primary = s.type === "Ayah" || s.type === "HadeethEncItem" || s.type === "CanonicalHadith";
  const neighbors = q.data?.neighbors || [];
  return (
    <article className={`mh-inspector ${typeClass(s.type)}`}>
      <header>
        <span className="mh-inspector__type">{t.types[s.type]}</span>
        <h3>{s.title}</h3>
        <code className="mh-id">{s.node_id}</code>
        {!props.sources[id] && <p className="mh-muted">{t.notInContext}</p>}
        {props.onOpenLibrary && s.type !== "Category" && s.type !== "Surah" && (
          <button type="button" className="mh-linklike mh-open-library" onClick={() => props.onOpenLibrary!(s.node_id)}>
            <BookOpen size={14} /> {t.openInLibrary}
          </button>
        )}
      </header>
      {primary && <SourceCard source={s} lang={props.lang} showArabic t={t} />}
      {s.type === "TafsirEntry" && s.commentary && (
        <section>
          <h4>{t.fullTafsir}</h4>
          <div className="mh-longtext" lang="en" dir="ltr">
            {s.commentary.split(/\n+/).map((para, i) =>
              /[؀-ۿ]/.test(para) && para.replace(/[^؀-ۿ]/g, "").length > para.length * 0.5 ? (
                <p key={i} className="mh-arabic mh-arabic--inline" lang="ar" dir="rtl">
                  {para}
                </p>
              ) : (
                <p key={i}>{para}</p>
              ),
            )}
          </div>
        </section>
      )}
      {s.type === "HadeethEncItem" && (
        <>
          {s.grade && (
            <p className="mh-inline-grade">
              {t.grade}: <GradeBadge grade={s.grade} />
            </p>
          )}
          <section>
            <h4>{t.sharh}</h4>
            {s.commentaryLang !== props.lang && <p className="mh-muted">{t.fallbackLang}</p>}
            <div className="mh-longtext" dir={s.commentaryLang === "ar" ? "rtl" : "ltr"} lang={s.commentaryLang}>
              {(s.commentary || "").split(/\n+/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          </section>
          {!!s.benefits?.length && (
            <section>
              <h4>{t.benefits}</h4>
              <ul className="mh-benefits" dir="ltr" lang="en">
                {s.benefits.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {s.type === "CanonicalHadith" && <p className="mh-muted">{t.noSharh}</p>}
      <section>
        <dl className="mh-meta">
          {Object.entries(s.meta)
            .filter(([, v]) => v !== null && v !== "")
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k.replaceAll("_", " ")}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
        </dl>
      </section>
      {neighbors.length > 0 && (
        <section>
          <h4>{t.connections}</h4>
          <ul className="mh-neighbors">
            {neighbors.slice(0, 24).map((e: TraceEdge) => {
              const other = e.from === s.node_id ? e.to : e.from;
              return (
                <li key={e.from + e.to + e.type}>
                  <span className="mh-edge-type">
                    {e.from === s.node_id ? "→" : "←"} {e.type}
                    {e.coverage === "passage" ? " · passage" : ""}
                  </span>
                  <button type="button" className="mh-linklike" onClick={() => props.onSelect(other)}>
                    {citationLabel(other, props.sources[other])}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}
