import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  CircleAlert,
  Gauge,
  Monitor,
  Moon,
  RotateCcw,
  ShieldAlert,
  Square,
  Sun,
} from "lucide-react";
import {
  citedIds,
  segment,
  type AskEvent,
  type ConversationTurn,
  type Lang,
  type LlmCatalog,
  type Persona,
  type ProviderId,
  type RetrievalTrace,
  type SourceNode,
} from "../../../../packages/shared/src/mihrab";
import { readStorage, writeStorage } from "../kit/util";
import { ask, fetchModels, fetchStatus, getConversation, locateNode } from "./api";
import { CHATS_KEY, History } from "./History";
import { Answer } from "./Answer";
import { ContextGraph } from "./ContextGraph";
import { Inspector } from "./Inspector";
import { STRINGS, personaEmoji, type Strings } from "./i18n";
import { CitationPill, SourceCard } from "./sources";
import { Library } from "./library/Library";
import { VoiceButton } from "./voice";
import "../styles/mihrab-theme.css";
import "./mihrab.css";

type Done = Extract<AskEvent, { type: "done" }>;
type Phase = "retrieving" | "reasoning" | "answering" | "done" | "error";
type Choice = { provider: ProviderId; model: string };
type Turn = {
  id: string;
  question: string;
  persona: Persona;
  lang: Lang;
  choice: Choice;
  phase: Phase;
  trace?: RetrievalTrace;
  sources: Record<string, SourceNode>;
  fatwa: boolean;
  answer: string;
  done?: Done;
  error?: string;
  stopped?: boolean;
};
// A saved turn, as the chat shows it.
const fromSaved = (t: ConversationTurn): Turn => ({
  id: t.id,
  question: t.question,
  persona: t.persona,
  lang: t.lang,
  choice: { provider: t.provider, model: t.model },
  phase: t.status === "error" ? "error" : "done",
  trace: t.trace ?? undefined,
  sources: t.sources,
  fatwa: t.fatwaSensitive,
  answer: t.answer,
  done: t.done ?? undefined,
  error: t.error,
  stopped: t.status === "stopped",
});
const CHAT_PATH = /^\/mihrab\/c\/([0-9a-f-]{36})(?:\/|$)/;
type ThemePref = "system" | "light" | "dark";
const key = (c: Choice) => `${c.provider}|${c.model}`;
const PRIMARY = new Set(["Ayah", "HadeethEncItem", "CanonicalHadith"]);

function ArchMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mh-arch" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M5 30V15.5C5 8.7 10.2 4.6 16 2c5.8 2.6 11 6.7 11 13.5V30" />
      <path d="M10.5 30V17.6c0-3.8 2.5-6.4 5.5-8 3 1.6 5.5 4.2 5.5 8V30" />
      <path d="M3 30h26" />
    </svg>
  );
}

function ModelPicker(props: {
  catalog?: LlmCatalog;
  choice: Choice | null;
  onChange: (c: Choice) => void;
  stats?: Done;
  t: Strings;
}) {
  const { catalog, choice, t } = props;
  const s = props.stats?.usage;
  return (
    <div className="mh-model">
      <label className="mh-visually-hidden" htmlFor="mh-model">
        {t.model}
      </label>
      <select
        id="mh-model"
        value={choice ? key(choice) : ""}
        onChange={(e) => {
          const [provider, ...model] = e.target.value.split("|");
          props.onChange({ provider: provider as ProviderId, model: model.join("|") });
        }}
      >
        {!catalog?.providers.some((p) => p.models.length) && <option value="">{t.noModels}</option>}
        {catalog?.providers.map((p) => (
          <optgroup key={p.id} label={`${p.id === "azure_foundry" ? t.azure : t.ollama}${p.available ? "" : ` (${t.unavailable})`}`}>
            {p.models.map((m) => (
              <option key={m.id} value={`${p.id}|${m.id}`} disabled={!p.available}>
                {m.label}
                {m.detail ? ` — ${m.detail}` : ""}
              </option>
            ))}
            {!p.models.length && (
              <option disabled value={`${p.id}|`}>
                {p.reason || t.unavailable}
              </option>
            )}
          </optgroup>
        ))}
      </select>
      <span className="mh-model__badge" title={`${t.latency} / ${t.firstToken} · ${t.tokens} (prompt → completion)`}>
        <Gauge size={13} aria-hidden />
        {s ? (
          <>
            {(s.latencyMs / 1000).toFixed(1)}s
            {s.firstTokenMs !== null && <small> · {(s.firstTokenMs / 1000).toFixed(1)}s</small>}
            {s.promptTokens !== null && (
              <small>
                {" "}
                · {fmtTokens(s.promptTokens)}→{fmtTokens(s.completionTokens)}
              </small>
            )}
          </>
        ) : (
          "—"
        )}
      </span>
    </div>
  );
}
const fmtTokens = (n: number | null) => (n === null ? "?" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

export default function MihrabWorkspace() {
  const [lang, setLang] = useState<Lang>(() => (["en", "de", "ar"].includes(readStorage("mihrab.lang")) ? (readStorage("mihrab.lang") as Lang) : "en"));
  const [persona, setPersona] = useState<Persona>(() => (readStorage("mihrab.persona") === "scholar" ? "scholar" : "explorer"));
  const [theme, setTheme] = useState<ThemePref>(() => {
    const v = readStorage("mihrab.theme", "system");
    return v === "light" || v === "dark" ? v : "system";
  });
  const [choice, setChoice] = useState<Choice | null>(() => {
    const v = readStorage("mihrab.model");
    const [provider, ...model] = v.split("|");
    return v ? { provider: provider as ProviderId, model: model.join("|") } : null;
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"graph" | "inspector">("graph");
  const [draft, setDraft] = useState("");
  const [stats, setStats] = useState<Record<string, Done>>({});
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const t = STRINGS[lang];
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onLibrary = /^\/mihrab\/library(\/|$)/.test(location.pathname);
  // The saved conversation in the address, and the one the turns on screen
  // belong to (null for a new chat). They differ only while one loads.
  const urlChat = CHAT_PATH.exec(location.pathname)?.[1] ?? null;
  const shown = useRef<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(() => readStorage("mihrab.history", "open") !== "closed");
  useEffect(() => {
    writeStorage("mihrab.history", historyOpen ? "open" : "closed");
  }, [historyOpen]);
  const refreshChats = () => void queryClient.invalidateQueries({ queryKey: CHATS_KEY });
  const chatPath = () => (shown.current ? `/mihrab/c/${shown.current}` : "/mihrab");
  function startNewChat() {
    shown.current = null;
    setTurns([]);
    setActiveId(null);
    setSelected(null);
    setChatError(null);
    navigate("/mihrab");
  }
  // Open the conversation in the address (the Library and the Ask view share
  // the page, so only Ask-view addresses switch it).
  useEffect(() => {
    if (onLibrary || urlChat === shown.current) return;
    if (!urlChat) {
      shown.current = null;
      setTurns([]);
      setActiveId(null);
      return;
    }
    let live = true,
      settled = false;
    const previous = shown.current;
    shown.current = urlChat;
    setChatError(null);
    setTurns([]);
    setSelected(null);
    getConversation(urlChat)
      .then((c) => {
        if (!live) return;
        const loaded = c.turns.map(fromSaved);
        setTurns(loaded);
        setActiveId(loaded.at(-1)?.id ?? null);
      })
      .catch((e: Error) => live && setChatError(e.message))
      .finally(() => {
        settled = live;
      });
    return () => {
      live = false;
      // A load cut short (React re-running effects in development, or a
      // quick switch) must run again next time, not count as shown.
      if (!settled) shown.current = previous;
    };
  }, [urlChat, onLibrary]);
  // From the Library: ask in the chat view, in the conversation already open.
  const askFromLibrary = (question: string) => {
    navigate(chatPath());
    send(question);
  };
  const openInLibrary = (id: string) =>
    locateNode(id, lang)
      .then((at) => navigate(`/mihrab/library/${at.book}/${at.chapter}?at=${encodeURIComponent(id)}`))
      .catch(() => {});

  const models = useQuery({ queryKey: ["mihrab-models"], queryFn: fetchModels, staleTime: 60_000 });
  const status = useQuery({ queryKey: ["mihrab-status"], queryFn: fetchStatus, staleTime: 60_000 });

  // Keep a stored choice only while it is still offered.
  useEffect(() => {
    const c = models.data;
    if (!c) return;
    const offered = (x: Choice | null) =>
      !!x && c.providers.some((p) => p.id === x.provider && p.available && p.models.some((m) => m.id === x.model));
    if (!offered(choice)) setChoice(c.default);
  }, [models.data]);
  useEffect(() => {
    writeStorage("mihrab.lang", lang);
  }, [lang]);
  useEffect(() => {
    writeStorage("mihrab.persona", persona);
  }, [persona]);
  useEffect(() => {
    writeStorage("mihrab.model", choice ? key(choice) : null);
  }, [choice]);
  useEffect(() => {
    writeStorage("mihrab.theme", theme);
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.mihrabTheme;
    else root.dataset.mihrabTheme = theme;
    return () => {
      delete root.dataset.mihrabTheme;
    };
  }, [theme]);
  useEffect(() => {
    document.title = "Mihrab · مِحْرَاب";
  }, []);

  const busy = turns.some((x) => ["retrieving", "reasoning", "answering"].includes(x.phase));
  const active = turns.find((x) => x.id === activeId) || turns.at(-1);
  const cited = useMemo(() => new Set(active ? citedIds(active.answer) : []), [active?.answer]);

  const update = (id: string, f: (x: Turn) => Turn) => setTurns((all) => all.map((x) => (x.id === id ? f(x) : x)));
  function send(question: string, override?: Choice) {
    const c = override || choice;
    if (!question.trim() || !c || busy) return;
    const id = crypto.randomUUID();
    const history = turns
      .filter((x) => x.phase === "done")
      .slice(-3)
      .flatMap((x) => [
        { role: "user" as const, content: x.question },
        { role: "assistant" as const, content: x.answer },
      ]);
    setTurns((all) => [
      ...all,
      { id, question, persona, lang, choice: c, phase: "retrieving", sources: {}, fatwa: false, answer: "" },
    ]);
    setActiveId(id);
    setSelected(null);
    setDraft("");
    const controller = new AbortController();
    abort.current = controller;
    const startedIn = shown.current;
    ask({ question, lang, persona, provider: c.provider, model: c.model, history, conversationId: startedIn ?? undefined }, (e) => {
      if (e.type === "conversation") {
        // A new chat was saved: give it its address, unless the person has
        // moved on to another conversation meanwhile.
        if (e.created && shown.current === startedIn) {
          shown.current = e.id;
          navigate(`/mihrab/c/${e.id}`, { replace: true });
        }
        refreshChats();
      } else if (e.type === "retrieval")
        update(id, (x) => ({ ...x, trace: e.trace, sources: e.sources, fatwa: e.fatwaSensitive }));
      else if (e.type === "phase") update(id, (x) => ({ ...x, phase: e.phase }));
      else if (e.type === "token") update(id, (x) => ({ ...x, phase: "answering", answer: x.answer + e.text }));
      else if (e.type === "done") {
        update(id, (x) => ({ ...x, phase: "done", done: e }));
        setStats((s) => ({ ...s, [key(c)]: e }));
      } else if (e.type === "error") update(id, (x) => ({ ...x, phase: "error", error: e.message }));
    }, controller.signal)
      .then(() => update(id, (x) => (x.phase === "done" || x.phase === "error" ? x : { ...x, phase: "done" })))
      .catch((err: Error) => {
        if (controller.signal.aborted) update(id, (x) => ({ ...x, phase: x.answer ? "done" : "error", stopped: true, error: x.answer ? undefined : t.stop }));
        else update(id, (x) => ({ ...x, phase: "error", error: err.message }));
      })
      // The saved conversation moved to the top of the history.
      .finally(() => setTimeout(refreshChats, 300));
  }
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, active?.phase]);

  const select = (id: string) => {
    setSelected(id);
  };
  const selectFromGraph = (id: string) => {
    setSelected(id);
    setTab("inspector");
  };

  return (
    <div className="mh-root" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      <header className="mh-top">
        <a
          className="mh-brand"
          href="/mihrab"
          aria-label="Mihrab"
          onClick={(e) => {
            e.preventDefault();
            navigate("/mihrab");
          }}
        >
          <ArchMark />
          <span className="mh-brand__name">Mihrab</span>
          <span className="mh-brand__ar" lang="ar">
            مِحْرَاب
          </span>
        </a>
        <nav className="mh-nav" aria-label="Mihrab">
          <button type="button" className={onLibrary ? "" : "is-on"} aria-current={onLibrary ? undefined : "page"} onClick={() => navigate("/mihrab")}>
            {t.navAsk}
          </button>
          <button type="button" className={onLibrary ? "is-on" : ""} aria-current={onLibrary ? "page" : undefined} onClick={() => navigate("/mihrab/library")}>
            {t.navLibrary}
          </button>
        </nav>
        <div className="mh-seg" role="radiogroup" aria-label="Persona">
          {(["explorer", "scholar"] as const).map((p) => (
            <button key={p} role="radio" aria-checked={persona === p} className={persona === p ? "is-on" : ""} title={p === "explorer" ? t.explorerHint : t.scholarHint} onClick={() => setPersona(p)}>
              <span aria-hidden>{personaEmoji[p]}</span> {p === "explorer" ? t.explorer : t.scholar}
            </button>
          ))}
        </div>
        <div className="mh-seg mh-seg--lang" role="radiogroup" aria-label="Language">
          {(["en", "de", "ar"] as const).map((l) => (
            <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? "is-on" : ""} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <ModelPicker catalog={models.data} choice={choice} onChange={setChoice} stats={choice ? stats[key(choice)] : undefined} t={t} />
        <button
          className="mh-icon-btn"
          aria-label={`${t.theme}: ${theme}`}
          title={`${t.theme}: ${theme}`}
          onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}
        >
          {theme === "system" ? <Monitor size={16} /> : theme === "light" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      {onLibrary && <Library lang={lang} t={t} onAsk={askFromLibrary} />}
      {/* Kept mounted while reading, so an answer keeps streaming. */}
      <main className={`mh-canvas ${historyOpen ? "has-history" : "has-rail"}`} hidden={onLibrary}>
        <History
          activeId={urlChat}
          open={historyOpen}
          onToggle={() => setHistoryOpen(!historyOpen)}
          onNew={startNewChat}
          onOpen={(chatId) => navigate(`/mihrab/c/${chatId}`)}
          onDeleted={(chatId) => chatId === shown.current && startNewChat()}
          t={t}
        />
        <section className="mh-stream" aria-label="Answers">
          <div className="mh-turns">
            {chatError && (
              <div className="mh-hero">
                <p className="mh-warning">
                  <CircleAlert size={15} /> {/not found/i.test(chatError) ? t.chatMissing : chatError}
                </p>
                <button type="button" className="mh-btn" onClick={startNewChat}>
                  {t.newChat}
                </button>
              </div>
            )}
            {!turns.length && !urlChat && !chatError && (
              <div className="mh-hero">
                <ArchMark size={72} />
                <h1>{t.emptyTitle}</h1>
                <p>{t.emptyBody}</p>
                <div className="mh-suggestions">
                  {t.suggestions[persona].map((s) => (
                    <button key={s} onClick={() => send(s)} disabled={!choice}>
                      {s}
                    </button>
                  ))}
                </div>
                {status.data?.ready && (
                  <p className="mh-corpus">
                    {t.corpus}: {status.data.counts.ayahs.toLocaleString()} {t.ayahs} · {status.data.counts.tafsir.toLocaleString()} {t.tafsir} ·{" "}
                    {(status.data.counts.hadeethenc + status.data.counts.canonical).toLocaleString()} {t.hadith} · {status.data.vectors ? t.hybrid : t.lexical}
                  </p>
                )}
                {status.data && !status.data.ready && (
                  <p className="mh-warning">
                    <CircleAlert size={15} /> Run <code>pnpm mihrab:seed</code> to build the Ring 1 corpus.
                  </p>
                )}
                {models.error && <p className="mh-warning">{String((models.error as Error).message)}</p>}
              </div>
            )}
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                active={turn.id === active?.id}
                onActivate={() => setActiveId(turn.id)}
                selected={selected}
                onSelect={select}
                current={choice}
                onAskAgain={(c) => send(turn.question, c)}
                busy={busy}
                t={STRINGS[turn.lang]}
                persona={turn.persona}
              />
            ))}
            <div ref={endRef} />
          </div>
          <form
            className="mh-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              value={draft}
              dir="auto"
              rows={2}
              placeholder={t.placeholder}
              aria-label={t.placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            <VoiceButton value={draft} onChange={setDraft} lang={lang} t={t} />
            {busy ? (
              <button type="button" className="mh-send is-stop" onClick={() => abort.current?.abort()} aria-label={t.stop}>
                <Square size={16} />
              </button>
            ) : (
              <button type="submit" className="mh-send" disabled={!draft.trim() || !choice} aria-label={t.ask}>
                <ArrowUp size={18} />
              </button>
            )}
            <small className="mh-composer__hint">{t.composerHint}</small>
          </form>
        </section>

        <aside className="mh-side" aria-label="Sources">
          <div className="mh-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "graph"} className={tab === "graph" ? "is-on" : ""} onClick={() => setTab("graph")}>
              {t.graph}
            </button>
            <button role="tab" aria-selected={tab === "inspector"} className={tab === "inspector" ? "is-on" : ""} onClick={() => setTab("inspector")}>
              {t.inspector}
            </button>
          </div>
          <div className="mh-side__body">
            {tab === "graph" ? (
              active?.trace ? (
                <ContextGraph key={active.id} trace={active.trace} sources={active.sources} cited={cited} selected={selected} onSelect={selectFromGraph} t={t} />
              ) : (
                <p className="mh-empty-pane">{t.graphEmpty}</p>
              )
            ) : (
              <div className="mh-inspector-wrap">
                <Inspector
                  id={selected}
                  sources={active?.sources || {}}
                  lang={lang}
                  showArabic={persona === "scholar" || lang === "ar"}
                  onSelect={select}
                  onOpenLibrary={openInLibrary}
                  t={t}
                />
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function TurnView(props: {
  turn: Turn;
  active: boolean;
  onActivate: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
  current: Choice | null;
  onAskAgain: (c: Choice) => void;
  busy: boolean;
  persona: Persona;
  t: Strings;
}) {
  const { turn, t } = props;
  const showArabic = turn.persona === "scholar" || turn.lang === "ar";
  // Every cited verse and hadith is shown verbatim, whether or not the model
  // placed a quote card for it.
  const quoted = new Set(segment(turn.answer).flatMap((s) => (s.kind === "quote" ? [s.id] : [])));
  const verified =
    turn.phase === "done"
      ? citedIds(turn.answer).filter((id) => turn.sources[id] && PRIMARY.has(turn.sources[id].type) && !quoted.has(id))
      : [];
  const d = turn.done;
  return (
    <article
      className={`mh-turn${props.active ? " is-active" : ""}`}
      dir={turn.lang === "ar" ? "rtl" : "ltr"}
      lang={turn.lang}
      onClick={props.onActivate}
    >
      <p className="mh-question" dir="auto">
        {turn.question}
      </p>
      <div className="mh-turn__meta">
        <span className="mh-chip">
          {personaEmoji[turn.persona]} {turn.persona === "explorer" ? t.explorer : t.scholar}
        </span>
        <span className="mh-chip mh-chip--model">
          {turn.choice.provider === "azure_foundry" ? t.azure : t.ollama} · {turn.choice.model}
        </span>
        {turn.trace && (
          <span className="mh-stages" title={turn.trace.stages.map((s) => `${s.name}: ${s.detail}`).join("\n")}>
            {t.stages}: {turn.trace.stages.map((s) => `${s.ms}ms`).join(" → ")} · {turn.trace.nodes.length} nodes ·{" "}
            {turn.trace.vector ? t.hybrid : t.lexical}
          </span>
        )}
      </div>
      {turn.fatwa && (
        <div className="mh-fatwa" role="note">
          <ShieldAlert size={18} aria-hidden />
          <div>
            <strong>{t.fatwaTitle}</strong>
            <p>{t.fatwaBody}</p>
          </div>
        </div>
      )}
      {turn.phase !== "done" && turn.phase !== "error" && !turn.answer && (
        <p className="mh-phase" aria-live="polite">
          <span className="mh-dots" aria-hidden />
          {turn.phase === "retrieving" ? t.retrieving : turn.phase === "reasoning" ? t.reasoning : t.answering}
        </p>
      )}
      {turn.answer && (
        <Answer text={turn.answer.trimStart()} sources={turn.sources} lang={turn.lang} showArabic={showArabic} selected={props.selected} onSelect={props.onSelect} t={t} />
      )}
      {turn.phase === "answering" && <span className="mh-caret" aria-hidden />}
      {turn.stopped && <p className="mh-muted">{t.stoppedNote}</p>}
      {turn.error && (
        <p className="mh-error" role="alert">
          <CircleAlert size={15} /> {t.error}: {turn.error}
        </p>
      )}
      {verified.length > 0 && (
        <section className="mh-verified">
          <h4>
            {t.verified} <small>{t.verifiedHint}</small>
          </h4>
          <div className="mh-verified__grid">
            {verified.map((id) => (
              <SourceCard key={id} source={turn.sources[id]} lang={turn.lang} showArabic={showArabic} t={t} compact selected={props.selected === id} onSelect={props.onSelect} />
            ))}
          </div>
        </section>
      )}
      {d && (d.citations.unknown.length > 0 || d.verbatim.length > 0) && (
        <div className="mh-guards">
          {d.citations.unknown.length > 0 && (
            <p>
              <CircleAlert size={14} /> {t.unknownCitations}:{" "}
              {d.citations.unknown.map((id) => (
                <CitationPill key={id} id={id} selected={false} onSelect={props.onSelect} t={t} />
              ))}
            </p>
          )}
          {d.verbatim.length > 0 && (
            <p>
              <CircleAlert size={14} /> {t.verbatimWarning}:{" "}
              {d.verbatim.map((v) => (
                <CitationPill key={v.node_id} id={v.node_id} source={turn.sources[v.node_id]} selected={props.selected === v.node_id} onSelect={props.onSelect} t={t} />
              ))}
            </p>
          )}
        </div>
      )}
      {d && (
        <footer className="mh-turn__foot">
          <span>
            {t.latency} {(d.usage.latencyMs / 1000).toFixed(1)}s
            {d.usage.firstTokenMs !== null && ` · ${t.firstToken} ${(d.usage.firstTokenMs / 1000).toFixed(1)}s`}
            {d.usage.promptTokens !== null && ` · ${fmtTokens(d.usage.promptTokens)}→${fmtTokens(d.usage.completionTokens)} ${t.tokens}`}
          </span>
          {props.current && key(props.current) !== key(turn.choice) && (
            <button
              type="button"
              className="mh-linklike"
              disabled={props.busy}
              onClick={(e) => {
                e.stopPropagation();
                props.onAskAgain(props.current!);
              }}
            >
              <RotateCcw size={13} /> {t.askAgain} {props.current.model}
            </button>
          )}
        </footer>
      )}
    </article>
  );
}
