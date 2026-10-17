// The chat history sidebar: saved conversations, newest first, grouped by
// day, with search, rename and delete.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Pencil, Search, Trash2, X } from "lucide-react";
import type { ConversationSummary } from "../../../../packages/shared/src/mihrab";
import { deleteConversation, listConversations, renameConversation } from "./api";
import type { Strings } from "./i18n";

export const CHATS_KEY = ["mihrab-conversations"];

function group(items: ConversationSummary[], t: Strings) {
  const day = 86_400_000,
    midnight = new Date().setHours(0, 0, 0, 0);
  const label = (iso: string) => {
    const at = Date.parse(iso);
    return at >= midnight ? t.today : at >= midnight - day ? t.yesterday : at >= midnight - 6 * day ? t.last7 : t.older;
  };
  const groups: { label: string; items: ConversationSummary[] }[] = [];
  for (const c of items) {
    const l = label(c.updatedAt);
    const g = groups.at(-1);
    if (g?.label === l) g.items.push(c);
    else groups.push({ label: l, items: [c] });
  }
  return groups;
}

function Item(props: { chat: ConversationSummary; active: boolean; onOpen: (id: string) => void; onDeleted: (id: string) => void; t: Strings }) {
  const { chat, t } = props;
  const client = useQueryClient();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [title, setTitle] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: CHATS_KEY });
  if (mode === "rename")
    return (
      <li className="mh-chat is-editing">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            setBusy(true);
            await renameConversation(chat.id, title).catch(() => {});
            setBusy(false);
            setMode("view");
            void refresh();
          }}
        >
          <input value={title} dir="auto" autoFocus aria-label={t.rename} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setMode("view")} />
          <button type="submit" aria-label={t.rename} disabled={busy}>
            <Check size={14} />
          </button>
          <button type="button" aria-label={t.cancel} onClick={() => setMode("view")}>
            <X size={14} />
          </button>
        </form>
      </li>
    );
  if (mode === "delete")
    return (
      <li className="mh-chat is-confirm" role="alertdialog" aria-label={t.deleteConfirm}>
        <span>{t.deleteConfirm}</span>
        <button
          type="button"
          className="is-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await deleteConversation(chat.id).catch(() => {});
            setBusy(false);
            props.onDeleted(chat.id);
            void refresh();
          }}
        >
          {t.deleteChat}
        </button>
        <button type="button" onClick={() => setMode("view")}>
          {t.cancel}
        </button>
      </li>
    );
  return (
    <li className={`mh-chat${props.active ? " is-on" : ""}`}>
      <button type="button" className="mh-chat__open" aria-current={props.active ? "page" : undefined} onClick={() => props.onOpen(chat.id)} title={chat.title}>
        <span dir="auto">{chat.title}</span>
      </button>
      <span className="mh-chat__actions">
        <button
          type="button"
          aria-label={`${t.rename}: ${chat.title}`}
          title={t.rename}
          onClick={() => {
            setTitle(chat.title);
            setMode("rename");
          }}
        >
          <Pencil size={13} />
        </button>
        <button type="button" aria-label={`${t.deleteChat}: ${chat.title}`} title={t.deleteChat} onClick={() => setMode("delete")}>
          <Trash2 size={13} />
        </button>
      </span>
    </li>
  );
}

export function History(props: {
  activeId: string | null;
  open: boolean;
  onToggle: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  t: Strings;
}) {
  const { t } = props;
  const [query, setQuery] = useState("");
  const chats = useQuery({
    queryKey: [...CHATS_KEY, query.trim()],
    queryFn: () => listConversations(query),
    placeholderData: (previous) => previous,
    staleTime: 10_000,
  });
  if (!props.open)
    return (
      <nav className="mh-history is-closed" aria-label={t.chats}>
        <button type="button" className="mh-history__icon" onClick={props.onToggle} aria-label={t.showChats} title={t.showChats}>
          <PanelLeftOpen size={18} className="mh-flip" />
        </button>
        <button type="button" className="mh-history__icon" onClick={props.onNew} aria-label={t.newChat} title={t.newChat}>
          <MessageSquarePlus size={18} />
        </button>
      </nav>
    );
  const unavailable = chats.error && /not available|501/.test(String((chats.error as Error).message));
  return (
    <nav className="mh-history" aria-label={t.chats}>
      <div className="mh-history__head">
        <button type="button" className="mh-history__new" onClick={props.onNew}>
          <MessageSquarePlus size={16} /> {t.newChat}
        </button>
        <button type="button" className="mh-history__icon" onClick={props.onToggle} aria-label={t.hideChats} title={t.hideChats}>
          <PanelLeftClose size={18} className="mh-flip" />
        </button>
      </div>
      <label className="mh-history__search">
        <Search size={14} aria-hidden />
        <input value={query} dir="auto" placeholder={t.searchChats} aria-label={t.searchChats} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="mh-history__list">
        {unavailable && <p className="mh-muted">{t.historyUnavailable}</p>}
        {chats.data && !chats.data.length && <p className="mh-muted">{query.trim() ? t.noChatMatches : t.noChats}</p>}
        {group(chats.data || [], t).map((g) => (
          <section key={g.label}>
            <h3>{g.label}</h3>
            <ul>
              {g.items.map((c) => (
                <Item key={c.id} chat={c} active={c.id === props.activeId} onOpen={props.onOpen} onDeleted={props.onDeleted} t={t} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
