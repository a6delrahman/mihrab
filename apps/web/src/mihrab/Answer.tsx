import { Fragment, type ReactNode } from "react";
import {
  segment,
  type Lang,
  type SourceNode,
} from "../../../../packages/shared/src/mihrab";
import type { Strings } from "./i18n";
import { CitationPill, SourceCard } from "./sources";

type Props = {
  text: string;
  sources: Record<string, SourceNode>;
  lang: Lang;
  showArabic: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  t: Strings;
};

// **bold** and *italic*; everything else is plain text (no HTML).
function emphasis(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={key + i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
      <em key={key + i}>{part.slice(1, -1)}</em>
    ) : (
      <Fragment key={key + i}>{part}</Fragment>
    ),
  );
}

export function Answer(p: Props) {
  // Quote markers become their own blocks, wherever the model put them.
  const blocks = p.text
    .replace(/\s*(\{\{\s*quote\s*:\s*[a-z0-9_:]+\s*\}\})\s*/g, "\n\n$1\n\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const inline = (text: string, key: string) =>
    segment(text).map((s, i) => {
      const k = `${key}.${i}`;
      if (s.kind === "text") return <Fragment key={k}>{emphasis(s.text, k)}</Fragment>;
      if (s.kind === "cite")
        return (
          <span key={k} className="mh-cite">
            {s.ids.map((id) => (
              <CitationPill key={id} id={id} source={p.sources[id]} selected={p.selected === id} onSelect={p.onSelect} t={p.t} />
            ))}
          </span>
        );
      return null;
    });
  return (
    <div className="mh-answer" dir={p.lang === "ar" ? "rtl" : "ltr"} lang={p.lang}>
      {blocks.map((block, bi) => {
        const quote = /^\{\{\s*quote\s*:\s*([a-z0-9_:]+)\s*\}\}$/.exec(block);
        if (quote) {
          const s = p.sources[quote[1]];
          return s ? (
            <SourceCard
              key={bi}
              source={s}
              lang={p.lang}
              showArabic={p.showArabic}
              t={p.t}
              selected={p.selected === s.node_id}
              onSelect={p.onSelect}
            />
          ) : (
            <p key={bi} className="mh-unverified-quote">
              ⚠ {quote[1]} — {p.t.notInContext}
            </p>
          );
        }
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]);
          const items = lines.map((l, li) => (
            <li key={li}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), `${bi}.${li}`)}</li>
          ));
          return ordered ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>;
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(block);
        if (heading && lines.length === 1) return <h4 key={bi}>{inline(heading[2], String(bi))}</h4>;
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l.replace(/^#{1,4}\s+/, ""), `${bi}.${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
