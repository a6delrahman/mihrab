import { Lock } from "lucide-react";
import type {
  HadithGrade,
  Lang,
  NodeType,
  SourceNode,
} from "../../../../packages/shared/src/mihrab";
import { nodeType } from "../../../../packages/shared/src/mihrab";
import type { Strings } from "./i18n";

const arabicDigits = (n: string) => n.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);

export function citationLabel(id: string, source?: SourceNode) {
  const [prefix, ...rest] = id.split(":");
  switch (prefix) {
    case "ayah":
      return rest.join(":");
    case "tafsir":
      return `Ibn Kathir ${rest.slice(1).join(":")}`;
    case "hadeethenc":
      return `HadeethEnc ${rest[0]}`;
    case "hadith":
      return `${{ bukhari: "Bukhari", muslim: "Muslim", nawawi40: "Nawawi" }[rest[0]] || rest[0]} ${rest[1]}`;
    case "category":
      return source?.title || rest[0].replaceAll("_", " ");
    case "surah":
      return source?.title || `Surah ${rest[0]}`;
    default:
      return id;
  }
}
export const typeClass = (t: NodeType | undefined) =>
  t ? "is-" + t.replace(/[A-Z]/g, (c, i) => (i ? "-" : "") + c.toLowerCase()) : "is-unknown";

export function CitationPill(props: {
  id: string;
  source?: SourceNode;
  selected: boolean;
  onSelect: (id: string) => void;
  t: Strings;
}) {
  const type = props.source?.type || nodeType(props.id);
  const known = !!props.source;
  return (
    <button
      type="button"
      className={`mh-pill ${typeClass(type)}${known ? "" : " is-unverified"}${props.selected ? " is-selected" : ""}`}
      onClick={() => props.onSelect(props.id)}
      title={known ? `${props.source!.title} — ${props.id}` : `${props.id} — ${props.t.notInContext}`}
    >
      {citationLabel(props.id, props.source)}
    </button>
  );
}

export function gradeTone(g: HadithGrade) {
  if (g.basis === "unknown") return "is-unknown";
  if (/da['ʿ]?if|weak|ضعيف/i.test(g.label)) return "is-daif";
  if (/hasan|good|sound|حسن/i.test(g.label) && !/sahih|authentic|صحيح/i.test(g.label)) return "is-hasan";
  return "is-sahih";
}
export function gradeShort(g: HadithGrade) {
  const tone = gradeTone(g);
  const base = tone === "is-sahih" ? "Ṣaḥīḥ" : tone === "is-hasan" ? "Ḥasan" : tone === "is-daif" ? "Ḍaʿīf" : "—";
  return g.basis === "collection" ? `${base} · collection` : g.basis === "unknown" ? "Grade not recorded" : base;
}
export function GradeBadge({ grade }: { grade: HadithGrade }) {
  return (
    <span className={`mh-grade ${gradeTone(grade)}${grade.basis === "collection" ? " is-collection" : ""}`} title={grade.detail || grade.label}>
      {gradeShort(grade)}
      {grade.basis === "graded" && <span className="mh-grade__full">{grade.label}</span>}
    </span>
  );
}

// The Immutable Source Card: a primary text exactly as the corpus holds it.
export function SourceCard(props: {
  source: SourceNode;
  lang: Lang;
  showArabic: boolean;
  t: Strings;
  selected?: boolean;
  compact?: boolean;
  onSelect?: (id: string) => void;
}) {
  const { source: s, lang, t } = props;
  const isAyah = s.type === "Ayah";
  const translationLang: "en" | "de" = lang === "de" && s.translation?.de ? "de" : "en";
  const translation = s.translation?.[translationLang];
  const missingDe = lang === "de" && !s.translation?.de;
  const ayahNo = isAyah ? String(s.meta.ayah_key).split(":")[1] : "";
  return (
    <figure
      className={`mh-card ${typeClass(s.type)}${props.selected ? " is-selected" : ""}${props.compact ? " is-compact" : ""}`}
      onClick={props.onSelect ? () => props.onSelect!(s.node_id) : undefined}
    >
      <header className="mh-card__head">
        <span className="mh-card__title">{s.title}</span>
        {s.grade && <GradeBadge grade={s.grade} />}
        <span className="mh-card__lock" title={t.immutable}>
          <Lock size={11} aria-hidden /> {t.immutable}
        </span>
      </header>
      {(props.showArabic || lang === "ar") && s.arabic && (
        <blockquote className="mh-arabic" lang="ar" dir="rtl">
          {props.compact && s.arabic.length > 420 ? s.arabic.slice(0, 420) + " …" : s.arabic}
          {isAyah && <span className="mh-ayah-no"> ﴿{arabicDigits(ayahNo)}﴾</span>}
        </blockquote>
      )}
      {translation && lang !== "ar" && (
        <blockquote className="mh-translation" lang={translationLang} dir="ltr">
          {props.compact && translation.length > 600 ? translation.slice(0, 600) + " …" : translation}
        </blockquote>
      )}
      {lang === "ar" && !s.arabic && translation && (
        <blockquote className="mh-translation" dir="ltr">
          {translation}
        </blockquote>
      )}
      <figcaption className="mh-card__foot">
        {isAyah && (
          <span>
            {s.meta.surah_ar} · {String(s.meta.revelation)} ·{" "}
            {translationLang === "de" ? s.meta.translation_de : s.meta.translation_en}
          </span>
        )}
        {s.attribution && (
          <span>
            {t.attribution}: {s.attribution}
          </span>
        )}
        {missingDe && <span className="mh-muted">{t.fallbackLang}</span>}
        <code className="mh-id">{s.node_id}</code>
      </figcaption>
    </figure>
  );
}
