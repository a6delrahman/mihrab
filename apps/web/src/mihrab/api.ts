import type {
  AskEvent,
  AskRequest,
  BookId,
  Conversation,
  ConversationSummary,
  Lang,
  LibraryBook,
  LibraryHit,
  LibraryPage,
  LlmCatalog,
  SourceNode,
  TraceEdge,
} from "../../../../packages/shared/src/mihrab";

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || `Request failed (HTTP ${res.status})`);
  return data as T;
}
export const fetchModels = () => fetch("/api/llm/models").then((r) => json<LlmCatalog>(r));
export type CorpusStatus =
  | { ready: false }
  | {
      ready: true;
      counts: Record<string, number>;
      vectors: { model: string; dims: number; count: number } | null;
    };
export const fetchStatus = () => fetch("/api/mihrab/status").then((r) => json<CorpusStatus>(r));
export const fetchNode = (id: string, lang: Lang) =>
  fetch(`/api/mihrab/nodes/${encodeURIComponent(id)}?lang=${lang}`).then((r) =>
    json<{ source: SourceNode; neighbors: TraceEdge[] }>(r),
  );

// Server-sent events over a POST: EventSource only does GET.
export async function ask(body: AskRequest, onEvent: (e: AskEvent) => void, signal: AbortSignal) {
  const res = await fetch("/api/mihrab/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) await json(res);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      for (const line of block.split("\n"))
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as AskEvent);
    }
  }
}

// ---------- Library ----------
export const fetchBooks = (lang: Lang) => fetch(`/api/mihrab/library?lang=${lang}`).then((r) => json<LibraryBook[]>(r));
export const fetchChapter = (book: string, chapter: string, lang: Lang, opts: { offset?: number; around?: string } = {}) => {
  const q = new URLSearchParams({ lang });
  if (opts.offset !== undefined) q.set("offset", String(opts.offset));
  if (opts.around) q.set("around", opts.around);
  return fetch(`/api/mihrab/library/${encodeURIComponent(book)}/${encodeURIComponent(chapter)}?${q}`).then((r) => json<LibraryPage>(r));
};
export const searchBook = (book: string, query: string, lang: Lang) =>
  fetch(`/api/mihrab/library/${encodeURIComponent(book)}/search?q=${encodeURIComponent(query)}&lang=${lang}`).then((r) =>
    json<LibraryHit[]>(r),
  );
export const locateNode = (id: string, lang: Lang) =>
  fetch(`/api/mihrab/locate/${encodeURIComponent(id)}?lang=${lang}`).then((r) => json<{ book: BookId; chapter: string }>(r));

// ---------- Chat history ----------
export const listConversations = (q = "") =>
  fetch(`/api/mihrab/conversations${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`).then((r) => json<ConversationSummary[]>(r));
export const getConversation = (id: string) => fetch(`/api/mihrab/conversations/${encodeURIComponent(id)}`).then((r) => json<Conversation>(r));
export const renameConversation = (id: string, title: string) =>
  fetch(`/api/mihrab/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  }).then((r) => json<ConversationSummary>(r));
export const deleteConversation = (id: string) =>
  fetch(`/api/mihrab/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
