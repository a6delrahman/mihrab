// Mihrab's chat history, kept in Foundry's store (HelixDB) in a scope of its
// own. A conversation is one record; each turn is a record whose id starts
// with the conversation's, so a conversation reads back in order with one
// range scan. Turns keep the question, answer, model, timings and retrieval
// trace; the verbatim source texts are rebuilt from the corpus on reading.
import type {
  ConversationSummary,
  ConversationTurn,
  Lang,
  Persona,
} from "../../../../packages/shared/src/mihrab.js";
import type { Resource } from "../../../../packages/shared/src/index.js";
import { AppError } from "../security.js";
import { resource, transaction, type Store } from "../store.js";

export const HISTORY_SCOPE = "mihrab";
const CONVERSATION = "mihrabConversation",
  TURN = "mihrabTurn";
const turnPrefix = (id: string) => `turn_${id}_`;
// A conversation keeps the first words of each question, for search.
const MAX_INDEXED = 50;
export const titleFrom = (question: string) => {
  const q = question.replace(/\s+/g, " ").trim();
  return q.length > 80 ? q.slice(0, 78).replace(/\s+\S*$/, "") + "…" : q;
};
export type StoredTurn = Omit<ConversationTurn, "id" | "at" | "sources">;

const summary = (r: Resource): ConversationSummary => ({
  id: r.id,
  title: r.name,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  turns: r.data.turns || 0,
  lang: r.data.lang,
  persona: r.data.persona,
});

export class MihrabHistory {
  constructor(private store: Store) {}

  async list(search?: string): Promise<ConversationSummary[]> {
    const q = search?.trim().toLowerCase();
    return (await this.store.list(HISTORY_SCOPE, CONVERSATION))
      .filter(
        (r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          (r.data.questions as string[] | undefined)?.some((x) => x.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summary);
  }

  async summary(id: string) {
    const r = await this.store.get(HISTORY_SCOPE, id);
    if (r?.kind !== CONVERSATION) throw new AppError(404, "Conversation not found");
    return summary(r);
  }

  async create(question: string, meta: { lang: Lang; persona: Persona }) {
    const r = await transaction(this.store, HISTORY_SCOPE, async (tx) =>
      tx.put(resource(HISTORY_SCOPE, CONVERSATION, titleFrom(question), { ...meta, turns: 0, questions: [] })),
    );
    return summary(r);
  }

  async turns(id: string, limit = 500): Promise<(StoredTurn & { id: string; at: string })[]> {
    const { items } = await this.store.page(HISTORY_SCOPE, turnPrefix(id), 0, limit);
    return items
      .filter((r) => r.kind === TURN)
      .map((r) => ({ id: r.id, at: r.createdAt, ...(r.data as StoredTurn) }));
  }

  async append(id: string, turn: StoredTurn) {
    return transaction(this.store, HISTORY_SCOPE, async (tx) => {
      const c = await tx.get(id);
      if (c?.kind !== CONVERSATION) throw new AppError(404, "Conversation not found");
      const seq = (c.data.turns || 0) + 1;
      tx.put(resource(HISTORY_SCOPE, TURN, turn.question.slice(0, 120), turn, `${turnPrefix(id)}${String(seq).padStart(5, "0")}`));
      tx.update(c, {
        ...c.data,
        turns: seq,
        lang: turn.lang,
        persona: turn.persona,
        questions: [...(c.data.questions || []), turn.question.slice(0, 200)].slice(-MAX_INDEXED),
      });
    });
  }

  async rename(id: string, title: string) {
    return transaction(this.store, HISTORY_SCOPE, async (tx) => {
      const c = await tx.get(id);
      if (c?.kind !== CONVERSATION) throw new AppError(404, "Conversation not found");
      return summary(tx.put({ ...c, name: title.trim(), revision: c.revision + 1, updatedAt: new Date().toISOString() }));
    });
  }

  async remove(id: string) {
    const turns = await this.turns(id, 10_000);
    await transaction(this.store, HISTORY_SCOPE, async (tx) => {
      const c = await tx.get(id);
      if (c?.kind !== CONVERSATION) throw new AppError(404, "Conversation not found");
      for (const t of turns) tx.delete(t.id);
      tx.delete(id);
    });
  }
}
