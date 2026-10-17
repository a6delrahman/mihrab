// Mihrab: grounded Islamic knowledge over the Ring 1 graph.
//
//   GET  /api/llm/models          Azure AI Foundry deployments + local Ollama models
//   GET  /api/mihrab/status       corpus, ontology and vector index
//   GET  /api/mihrab/nodes/:id    one node, verbatim, with its edges
//   POST /api/mihrab/retrieve     the three retrieval stages, without a model
//   POST /api/mihrab/ask          retrieval, then the model's answer as server-sent events
//   GET/PATCH/DELETE /api/mihrab/conversations[/:id]   chat history
//
// The corpus is read-only and the same for every workspace, so these routes
// are not workspace-scoped; app.ts's host and origin checks still apply.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AskSchema,
  LANGS,
  NODE_ID,
  RenameSchema,
  detectLang,
  isPersonalRuling,
  type AskEvent,
  type ConversationSummary,
  type DoneInfo,
} from "../../../../packages/shared/src/mihrab.js";
import { config } from "../config.js";
import { assert } from "../security.js";
import { LLMProviderRouter } from "../services/llmProviderRouter.js";
import { MihrabCorpus } from "../services/mihrabCorpus.js";
import { MihrabRetriever } from "../services/mihrabRetriever.js";
import { MihrabLibrary } from "../services/mihrabLibrary.js";
import { buildMessages, checkCitations, verbatimSpans } from "../services/mihrabPrompt.js";
import { embedderFromEnv } from "../../../../services/executor/src/mihrab-vectors.js";
import { MihrabHistory } from "../services/mihrabHistory.js";
import type { Store } from "../store.js";

export type MihrabDeps = {
  corpus: MihrabCorpus;
  retriever: MihrabRetriever;
  router: LLMProviderRouter;
  library?: MihrabLibrary;
  chats?: MihrabHistory;
};
export function mihrabDeps(): MihrabDeps {
  // MIHRAB_EMBED_PROVIDER picks the query embedder; it must match the
  // vectors `pnpm mihrab:seed` built.
  const embedder = embedderFromEnv(process.env, config.ollama);
  const corpus = new MihrabCorpus({ embedderId: embedder.id });
  return {
    corpus,
    retriever: new MihrabRetriever(corpus, embedder),
    router: new LLMProviderRouter(process.env, config.ollama),
  };
}

const RetrieveSchema = AskSchema.pick({ question: true, lang: true, persona: true, history: true });

export function registerMihrabRoutes(app: FastifyInstance, deps: MihrabDeps = mihrabDeps(), store?: Store) {
  const { corpus, retriever, router } = deps;
  const library = deps.library ?? new MihrabLibrary(corpus);
  // Chat history lives in Foundry's store; without one, answers are not saved.
  const chats = deps.chats ?? (store ? new MihrabHistory(store) : undefined);
  const needChats = () => {
    assert(chats, "Chat history is not available on this server", 501);
    return chats;
  };
  app.addHook("onClose", async () => corpus.close());
  const langOf = (q: any) => z.enum(LANGS).catch("en").parse(q?.lang);

  // ---------- Library ----------
  app.get("/api/mihrab/library", async (req: any) => library.books(langOf(req.query)));
  app.get("/api/mihrab/locate/:id", async (req: any) => {
    const id = String(req.params.id);
    assert(NODE_ID.test(id), "Not a node id", 400);
    const at = await library.locate(id, langOf(req.query));
    assert(at, "This node is not in the Library", 404);
    return at;
  });
  app.get("/api/mihrab/library/:book", async (req: any) => library.book(String(req.params.book), langOf(req.query)));
  app.get("/api/mihrab/library/:book/search", async (req: any) =>
    library.search(String(req.params.book), String(req.query.q || "").slice(0, 200), langOf(req.query)),
  );
  app.get("/api/mihrab/library/:book/:chapter", async (req: any) => {
    const n = (v: unknown) => (v === undefined ? undefined : Math.max(0, Number(v) || 0));
    const around = typeof req.query.around === "string" && NODE_ID.test(req.query.around) ? req.query.around : undefined;
    return library.chapter(String(req.params.book), String(req.params.chapter), {
      lang: langOf(req.query),
      offset: n(req.query.offset),
      limit: n(req.query.limit),
      around,
    });
  });

  app.get("/api/llm/models", async () => router.listModels());

  app.get("/api/mihrab/status", async () => corpus.status());

  app.get("/api/mihrab/nodes/:id", async (req: any) => {
    const id = String(req.params.id);
    assert(NODE_ID.test(id), "Not a node id", 400);
    const lang = z.enum(LANGS).catch("en").parse(req.query.lang);
    const node = await retriever.node(id, lang);
    assert(node, "Node not found", 404);
    return node;
  });

  app.post("/api/mihrab/retrieve", async (req) => {
    const b = RetrieveSchema.parse(req.body);
    const lang = b.lang ?? detectLang(b.question);
    const r = await retriever.retrieve({ ...b, lang });
    return { lang, ...r };
  });

  // ---------- Chat history ----------
  app.get("/api/mihrab/conversations", async (req: any) =>
    needChats().list(typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined),
  );
  app.get("/api/mihrab/conversations/:id", async (req: any) => {
    const c = needChats();
    const summary = await c.summary(String(req.params.id));
    const turns = await c.turns(summary.id);
    // The verbatim sources each answer used, from the corpus, by node id.
    return {
      summary,
      turns: await Promise.all(
        turns.map(async (t) => ({
          ...t,
          sources: t.trace ? await retriever.sources(t.trace.nodes.map((n) => n.id), t.lang) : {},
        })),
      ),
    };
  });
  app.patch("/api/mihrab/conversations/:id", async (req: any) =>
    needChats().rename(String(req.params.id), RenameSchema.parse(req.body).title),
  );
  app.delete("/api/mihrab/conversations/:id", async (req: any) => {
    await needChats().remove(String(req.params.id));
    return { ok: true };
  });

  app.post("/api/mihrab/ask", async (req, reply) => {
    const b = AskSchema.parse(req.body);
    const lang = b.lang ?? detectLang(b.question);
    const started = Date.now();
    await router.validate(b.provider, b.model);
    // A saved conversation supplies its own recent turns as context.
    let conversation: ConversationSummary | null = b.conversationId ? await needChats().summary(b.conversationId) : null;
    const history = conversation
      ? (await chats!.turns(conversation.id))
          .filter((t) => t.status === "done" && t.answer)
          .slice(-3)
          .flatMap((t) => [
            { role: "user" as const, content: t.question },
            { role: "assistant" as const, content: t.answer.slice(0, 8000) },
          ])
      : b.history;
    // Retrieval completes before the model is called; a failure here is a
    // plain JSON error.
    const r = await retriever.retrieve({ question: b.question, lang, persona: b.persona, history });
    const fatwaSensitive = isPersonalRuling(b.question);
    let created = false;
    if (!conversation && chats)
      try {
        conversation = await chats.create(b.question, { lang, persona: b.persona });
        created = true;
      } catch (e: any) {
        req.log.warn({ err: e?.message }, "mihrab conversation not saved");
      }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const abort = new AbortController();
    reply.raw.on("close", () => abort.abort());
    const send = (e: AskEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    let answer = "",
      firstTokenMs: number | null = null,
      promptTokens: number | null = null,
      completionTokens: number | null = null,
      reasoning = false,
      done: DoneInfo | null = null,
      failure: string | undefined;
    try {
      if (conversation) send({ type: "conversation", id: conversation.id, title: conversation.title, created });
      send({ type: "retrieval", trace: r.trace, sources: r.sources, fatwaSensitive });
      const messages = buildMessages({
        question: b.question,
        lang,
        persona: b.persona,
        fatwaSensitive,
        context: r.context,
        notes: r.trace.notes,
        history,
      });
      for await (const part of router.stream({
        provider: b.provider,
        model: b.model,
        messages,
        signal: abort.signal,
        maxTokens: b.persona === "scholar" ? 2200 : 1400,
      })) {
        if (part.type === "token") {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - started;
            send({ type: "phase", phase: "answering" });
          }
          answer += part.text;
          send({ type: "token", text: part.text });
        } else if (part.type === "thinking") {
          if (!reasoning) send({ type: "phase", phase: "reasoning" });
          reasoning = true;
        } else {
          promptTokens = part.promptTokens;
          completionTokens = part.completionTokens;
        }
      }
      done = {
        type: "done",
        usage: { promptTokens, completionTokens, latencyMs: Date.now() - started, firstTokenMs },
        citations: checkCitations(answer, new Set(Object.keys(r.sources))),
        verbatim: verbatimSpans(answer, r.sources),
        model: { provider: b.provider, model: b.model },
      };
      send(done);
    } catch (e: any) {
      if (!abort.signal.aborted) {
        req.log.warn({ err: e?.message }, "mihrab answer failed");
        failure = e?.statusCode ? e.message : "The model request failed; check the server log.";
        send({ type: "error", message: failure! });
      }
    } finally {
      reply.raw.end();
      // Saved however the answer ended, even if the page was closed meanwhile.
      if (conversation && chats)
        await chats
          .append(conversation.id, {
            question: b.question,
            persona: b.persona,
            lang,
            provider: b.provider,
            model: b.model,
            answer,
            status: done ? "done" : abort.signal.aborted ? "stopped" : "error",
            error: failure,
            fatwaSensitive,
            trace: r.trace,
            done,
          })
          .catch((e: any) => req.log.warn({ err: e?.message }, "mihrab turn not saved"));
    }
  });
}
