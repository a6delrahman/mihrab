import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  citedIds,
  detectLang,
  isPersonalRuling,
  nodeType,
  normalizeArabic,
  segment,
} from "../packages/shared/src/mihrab.js";
import {
  LLMProviderRouter,
  ThinkFilter,
  azureAnthropicBase,
  azureChatTarget,
  azureSettings,
  type ClaudeClient,
} from "../apps/api/src/services/llmProviderRouter.js";
import {
  azureEmbedder,
  azureEmbeddingsTarget,
  embedderFromEnv,
} from "../services/executor/src/mihrab-vectors.js";
import {
  excerpt,
  explicitRefs,
  fuse,
  isFollowUp,
  MihrabRetriever,
} from "../apps/api/src/services/mihrabRetriever.js";
import {
  buildMessages,
  checkCitations,
  verbatimSpans,
} from "../apps/api/src/services/mihrabPrompt.js";
import { MihrabCorpus } from "../apps/api/src/services/mihrabCorpus.js";
import { buildCatalog, splitText } from "../services/executor/src/mihrab-catalog.js";
import { ring1Bundle } from "../apps/api/src/services/mihrabFoundry.js";
import { MihrabLibrary } from "../apps/api/src/services/mihrabLibrary.js";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore } from "../apps/api/src/store.js";
import { mergeRanges } from "../apps/web/src/mihrab/library/store.js";
import { BundleSchema } from "../packages/shared/src/index.js";

// A stand-in for the Claude SDK client: replays stream events, then the final message.
const fakeClaude = (events: any[], final: any, seen: any[]) =>
  ((baseURL: string, apiKey: string) => ({
    messages: {
      stream: (params: any, options: any) => {
        seen.push({ baseURL, apiKey, params, options });
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalMessage: async () => final,
        };
      },
    },
  })) as unknown as (baseURL: string, apiKey: string) => ClaudeClient;

describe("citations", () => {
  it("splits prose, citation pills and quote cards", () => {
    const s = segment(
      "Allah is the Ever-Living [ayah:2:255; tafsir:ibn_kathir_en:2:255].\n{{quote:ayah:2:255}}\nSee [note] and [hadith:bukhari:1]",
    );
    expect(s.map((x) => x.kind)).toEqual(["text", "cite", "text", "quote", "text", "cite"]);
    expect(s[1]).toMatchObject({ ids: ["ayah:2:255", "tafsir:ibn_kathir_en:2:255"] });
    // "[note]" is not a node id, so it stays prose.
    expect((s[4] as any).text).toContain("[note]");
  });
  it("leaves an unfinished bracket from a stream as text", () => {
    expect(segment("Mercy [ayah:21:1").every((x) => x.kind === "text")).toBe(true);
  });
  it("separates cited ids that are in the context from invented ones", () => {
    const answer = "A [ayah:2:255] B [hadeethenc:99999999] {{quote:hadith:bukhari:1}}";
    expect(citedIds(answer)).toEqual(["ayah:2:255", "hadeethenc:99999999", "hadith:bukhari:1"]);
    expect(checkCitations(answer, new Set(["ayah:2:255", "hadith:bukhari:1"]))).toEqual({
      valid: ["ayah:2:255", "hadith:bukhari:1"],
      unknown: ["hadeethenc:99999999"],
    });
  });
  it("types node ids", () => {
    expect(nodeType("tafsir:ibn_kathir_en:2:255")).toBe("TafsirEntry");
    expect(nodeType("hadeethenc:3142")).toBe("HadeethEncItem");
    expect(nodeType("ayah:2")).toBeUndefined();
  });
});

describe("language and guardrails", () => {
  it("normalises Uthmani script for search", () => {
    expect(normalizeArabic("ٱلرَّحْمَٰنِ ٱلرَّحِيمِ")).toBe("الرحمن الرحيم");
    expect(normalizeArabic("إِلَىٰ")).toBe("الي");
  });
  it("detects the question's language", () => {
    expect(detectLang("Who was the first person to accept Islam?")).toBe("en");
    expect(detectLang("Was sagt der Islam über Geduld?")).toBe("de");
    expect(detectLang("ما فضل الصبر")).toBe("ar");
  });
  it("flags personal rulings, not general questions", () => {
    expect(isPersonalRuling("Can I divorce my husband if he doesn't pray?")).toBe(true);
    expect(isPersonalRuling("How is my late father's estate divided?")).toBe(true);
    expect(isPersonalRuling("Darf ich mich von meinem Ehemann scheiden lassen?")).toBe(true);
    expect(isPersonalRuling("What does the Qur'an say about divorce?")).toBe(false);
    expect(isPersonalRuling("I will read Surah al-Kahf on Friday")).toBe(false);
  });
  it("flags primary text copied into prose, but not quote cards", () => {
    const sources = {
      "ayah:1:2": {
        node_id: "ayah:1:2",
        type: "Ayah" as const,
        title: "Al-Fatiha 1:2",
        translation: { en: "[All] praise is [due] to Allah, Lord of the worlds and all that is in them" },
        meta: {},
      },
    };
    expect(verbatimSpans("{{quote:ayah:1:2}} It praises Allah [ayah:1:2].", sources)).toEqual([]);
    expect(verbatimSpans("It says praise is due to Allah Lord of the worlds and all that", sources)).toHaveLength(1);
  });
  it("builds a prompt that keeps primary texts behind quote markers", () => {
    const [system, user] = buildMessages({
      question: "Q",
      lang: "de",
      persona: "explorer",
      fatwaSensitive: true,
      context: [{ id: "ayah:1:1", type: "Ayah", hop: 0, label: "x", body: "PRIMARY TEXT", notes: [] }],
      notes: ["BM25 only."],
      history: [],
    });
    expect(system.content).toContain("{{quote:NODE_ID}}");
    expect(system.content).toContain("German");
    expect(system.content).toContain("apply the guardrail");
    expect(user.content).toContain('<node id="ayah:1:1"');
    expect(user.content).toContain("BM25 only.");
  });
});

describe("LLM router", () => {
  it("builds the right Azure AI Foundry URL for each endpoint shape", () => {
    const v = "2024-10-21";
    expect(azureChatTarget({ endpoint: "https://r.openai.azure.com", apiVersion: v }, "gpt-4o")).toEqual({
      url: "https://r.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
      modelInBody: false,
    });
    expect(azureChatTarget({ endpoint: "https://r.services.ai.azure.com/models", apiVersion: "2024-05-01-preview" }, "DeepSeek-R1")).toEqual({
      url: "https://r.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      modelInBody: true,
    });
    expect(azureChatTarget({ endpoint: "https://r.openai.azure.com/openai/v1", apiVersion: v }, "gpt-4.1")).toEqual({
      url: "https://r.openai.azure.com/openai/v1/chat/completions",
      modelInBody: true,
    });
    expect(() => azureChatTarget({ endpoint: "http://r.openai.azure.com", apiVersion: v }, "x")).toThrow(/https/);
  });
  it("reads Azure settings only when complete", () => {
    expect(azureSettings({ AZURE_FOUNDRY_ENDPOINT: "https://r.openai.azure.com/" })).toBeNull();
    expect(
      azureSettings({
        AZURE_FOUNDRY_ENDPOINT: "https://r.openai.azure.com/",
        AZURE_FOUNDRY_API_KEY: "k",
        AZURE_FOUNDRY_DEPLOYMENTS: " gpt-4o, Phi-4 ,",
      }),
    ).toEqual({ endpoint: "https://r.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", deployments: ["gpt-4o", "Phi-4"] });
  });
  it("drops <think> blocks even when split across chunks", () => {
    const f = new ThinkFilter();
    const out = ["Hel", "lo <thi", "nk>secret</th", "ink> world", " <"].map((c) => f.push(c)).join("") + f.flush();
    expect(out).toBe("Hello  world <");
  });
  it("lists Azure deployments and chat-capable Ollama models", async () => {
    const http = (async (url: string) =>
      new Response(
        JSON.stringify({
          models: [
            { name: "qwen3:4b", capabilities: ["completion", "thinking"], details: { parameter_size: "4.0B" } },
            { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
          ],
        }),
      )) as unknown as typeof fetch;
    const router = new LLMProviderRouter(
      { AZURE_FOUNDRY_ENDPOINT: "https://r.openai.azure.com", AZURE_FOUNDRY_API_KEY: "k", AZURE_FOUNDRY_DEPLOYMENTS: "gpt-4o" },
      "http://ollama",
      http,
    );
    const c = await router.listModels();
    expect(c.providers.map((p) => [p.id, p.models.map((m) => m.id)])).toEqual([
      ["azure_foundry", ["gpt-4o"]],
      ["ollama", ["qwen3:4b"]],
    ]);
    expect(c.default).toEqual({ provider: "azure_foundry", model: "gpt-4o" });
  });
  it("streams an Azure answer with usage, sending the key only as api-key", async () => {
    let seen: any;
    const sse = [
      { choices: [{ delta: { content: "Mercy " } }] },
      { choices: [{ delta: { content: "[ayah:21:107]" } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]
      .map((j) => `data: ${JSON.stringify(j)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const http = (async (url: string, init: any) => {
      seen = { url, init };
      return new Response(sse);
    }) as unknown as typeof fetch;
    const router = new LLMProviderRouter(
      { AZURE_FOUNDRY_ENDPOINT: "https://r.openai.azure.com", AZURE_FOUNDRY_API_KEY: "secret", AZURE_FOUNDRY_DEPLOYMENTS: "gpt-4o" },
      "http://ollama",
      http,
    );
    const parts = [];
    for await (const p of router.stream({ provider: "azure_foundry", model: "gpt-4o", messages: [{ role: "user", content: "q" }] }))
      parts.push(p);
    expect(parts).toEqual([
      { type: "token", text: "Mercy " },
      { type: "token", text: "[ayah:21:107]" },
      { type: "usage", promptTokens: 10, completionTokens: 4 },
    ]);
    expect(seen.init.headers["api-key"]).toBe("secret");
    expect(seen.init.redirect).toBe("error");
    expect(seen.url).not.toContain("secret");
  });
});

describe("Claude on Azure AI Foundry", () => {
  const env = {
    AZURE_FOUNDRY_ENDPOINT: "https://res.services.ai.azure.com/anthropic/v1/messages",
    AZURE_FOUNDRY_API_KEY: "secret",
    AZURE_FOUNDRY_DEPLOYMENTS: "claude-sonnet-5,chat-orchestrator",
  };

  it("routes each deployment on one resource", () => {
    expect(azureAnthropicBase(env.AZURE_FOUNDRY_ENDPOINT)).toBe("https://res.services.ai.azure.com/anthropic/");
    expect(azureChatTarget({ endpoint: env.AZURE_FOUNDRY_ENDPOINT, apiVersion: "2024-10-21" }, "chat-orchestrator").url).toBe(
      "https://res.services.ai.azure.com/openai/deployments/chat-orchestrator/chat/completions?api-version=2024-10-21",
    );
  });
  it("streams text, signals thinking, reports usage and sends the system prompt apart", async () => {
    const seen: any[] = [];
    const router = new LLMProviderRouter(env, "http://ollama", fetch, fakeClaude(
      [
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Mercy " } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "[ayah:21:107]" } },
      ],
      { stop_reason: "end_turn", usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 9 } },
      seen,
    ));
    const parts = [];
    for await (const p of router.stream({
      provider: "azure_foundry",
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "q" },
      ],
    }))
      parts.push(p);
    expect(parts).toEqual([
      { type: "thinking" },
      { type: "thinking" },
      { type: "token", text: "Mercy " },
      { type: "token", text: "[ayah:21:107]" },
      { type: "usage", promptTokens: 150, completionTokens: 9 },
    ]);
    expect(seen[0]).toMatchObject({
      baseURL: "https://res.services.ai.azure.com/anthropic/",
      apiKey: "secret",
      params: { model: "claude-sonnet-5", thinking: { type: "adaptive" }, messages: [{ role: "user", content: "q" }] },
    });
    expect(seen[0].params.system[0]).toMatchObject({ text: "rules", cache_control: { type: "ephemeral" } });
    expect(seen[0].params).not.toHaveProperty("temperature");
  });
  it("turns a refusal into a clear error", async () => {
    const router = new LLMProviderRouter(env, "http://ollama", fetch, fakeClaude([], { stop_reason: "refusal", usage: {} }, []));
    const run = async () => {
      for await (const _ of router.stream({ provider: "azure_foundry", model: "claude-sonnet-5", messages: [{ role: "user", content: "q" }] }));
    };
    await expect(run()).rejects.toThrow(/declined/);
  });
});

describe("Azure embeddings", () => {
  it("builds the deployments URL and picks the embedder from the environment", () => {
    expect(azureEmbeddingsTarget({ endpoint: "https://res.services.ai.azure.com", deployment: "embedding", apiVersion: "2024-10-21" })).toEqual({
      url: "https://res.services.ai.azure.com/openai/deployments/embedding/embeddings?api-version=2024-10-21",
      modelInBody: false,
    });
    const env = {
      AZURE_FOUNDRY_EMBEDDINGS_ENDPOINT: "https://res.services.ai.azure.com",
      AZURE_FOUNDRY_EMBEDDINGS_KEY: "k",
      AZURE_FOUNDRY_EMBEDDINGS_DEPLOYMENT: "embedding",
    };
    expect(embedderFromEnv(env).id).toBe("nomic-embed-text-v2-moe");
    expect(embedderFromEnv({ ...env, MIHRAB_EMBED_PROVIDER: "azure_foundry" }).id).toBe("azure-embedding-1024");
    expect(() => embedderFromEnv({ MIHRAB_EMBED_PROVIDER: "azure_foundry" })).toThrow(/AZURE_FOUNDRY_EMBEDDINGS/);
  });
  it("orders vectors by index, counts tokens and retries a rate limit", async () => {
    let calls = 0,
      body: any;
    const http = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      if (calls++ === 0) return new Response("busy", { status: 429, headers: { "retry-after": "0.01" } });
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }], usage: { total_tokens: 7 } }));
    }) as unknown as typeof fetch;
    const e = azureEmbedder({ endpoint: "https://res.services.ai.azure.com", apiKey: "k", deployment: "embedding", apiVersion: "2024-10-21", dimensions: 1024 }, http);
    expect(await e.embed(["a", "b"], "document")).toEqual([[1], [2]]);
    expect(calls).toBe(2);
    expect(e.tokens).toBe(7);
    expect(body).toEqual({ input: ["a", "b"], dimensions: 1024 });
  });
});

describe("retrieval helpers", () => {
  it("recognises follow-up questions", () => {
    expect(isFollowUp("And in hadith?")).toBe(true);
    expect(isFollowUp("What does Ibn Kathir say about its virtue?")).toBe(true);
    expect(isFollowUp("Was sagen die Gelehrten über seine Bedeutung?")).toBe(true);
    expect(isFollowUp("ما الذي قاله ابن كثير عن فضلها وعن هذا الحديث؟")).toBe(true);
    expect(isFollowUp("What does the Qur'an teach about patience in hardship?")).toBe(false);
  });
  it("finds explicit references", () => {
    expect(explicitRefs("Explain 2:255 and Sahih Bukhari no. 1, also Nawawi #13")).toEqual([
      "ayah:2:255",
      "hadith:bukhari:1",
      "hadith:nawawi40:13",
    ]);
    expect(explicitRefs("at 10:30:15")).toEqual([]);
  });
  it("fuses ranked lists by reciprocal rank", () => {
    const hit = (node_id: string, seq = 0) => ({ chunk_key: node_id + seq, node_id, node_type: "Ayah" as const, seq, text: "", score: 1 });
    const out = fuse([
      ["bm25", [hit("ayah:1:1"), hit("ayah:1:2"), hit("ayah:1:1", 1)]],
      ["vector", [hit("ayah:1:2"), hit("ayah:1:3")]],
    ]);
    expect(out.map((c) => c.id)).toEqual(["ayah:1:2", "ayah:1:1", "ayah:1:3"]);
    expect(out[1].seqs).toEqual([0, 1]);
  });
  it("splits text into chunks without losing any of it", () => {
    const text = "Heading\n" + "A sentence that goes on. ".repeat(120) + "\nTail.";
    const chunks = splitText(text, 300);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });
  it("excerpts the opening and matched chunks within budget", () => {
    const chunks = [0, 1, 2, 3].map((seq) => ({ seq, text: `chunk ${seq} `.repeat(10) }));
    const e = excerpt(chunks, [3], 400);
    expect(e).toContain("chunk 0");
    expect(e).toContain("[…]");
    expect(e).toContain("chunk 3");
    expect(e).not.toContain("chunk 1");
  });
});

// A tiny Ring 1 corpus: two ayahs of al-Fatiha with passage commentary, one
// ayah of al-Fil with none, a HadeethEnc item and a Bukhari hadith.
describe("catalog and multi-hop retrieval", () => {
  let dir: string, corpus: MihrabCorpus;
  beforeAll(async () => {
    dir = await mkdtemp(resolve(tmpdir(), "mihrab-"));
    await mkdir(resolve(dir, "parquet"), { recursive: true });
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    const out = (t: string, sql: string) => c.run(`COPY (${sql}) TO '${resolve(dir, "parquet", t + ".parquet")}' (FORMAT parquet)`);
    await out("surahs", `SELECT * FROM (VALUES ('surah:1', 1, 'الفاتحة', 'Al-Faatiha', 'The Opening', 'Meccan', 7), ('surah:105', 105, 'الفيل', 'Al-Fil', 'The Elephant', 'Meccan', 5)) t(node_id, surah_number, name_ar, name_en, name_translation_en, revelation_place, ayah_count)`);
    await out("quran_ayahs", `SELECT * FROM (VALUES
      ('ayah:1:1','1:1',1,1,'الفاتحة','Al-Faatiha','Meccan',1,1,'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ','In the name of Allah, the Entirely Merciful, the Especially Merciful.','Im Namen Allahs, des Allerbarmers, des Barmherzigen.'),
      ('ayah:1:2','1:2',1,2,'الفاتحة','Al-Faatiha','Meccan',1,1,'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ','[All] praise is [due] to Allah, Lord of the worlds','(Alles) Lob gehört Allah, dem Herrn der Weltenbewohner'),
      ('ayah:105:1','105:1',105,1,'الفيل','Al-Fil','Meccan',30,60,'أَلَمْ تَرَ كَيْفَ فَعَلَ رَبُّكَ بِأَصْحَٰبِ ٱلْفِيلِ','Have you not considered how your Lord dealt with the companions of the elephant?','Hast du nicht gesehen, wie dein Herr mit den Leuten des Elefanten verfuhr?')
    ) t(node_id, ayah_key, surah_number, ayah_number, surah_name_ar, surah_name_en, revelation_place, juz_number, hizb_number, text_uthmani, translation_en, translation_de)`);
    await out("tafsir_entries", `SELECT 'tafsir:ibn_kathir_en:1:1' AS "node_id", '1:1' AS "ayah_key", 'ibn_kathir_en' AS "source_slug", 'Hafiz Ibn Kathir' AS "author_name", 'en' AS "language", 'The Basmalah and mercy\nAr-Rahman and Ar-Rahim are names of Allah derived from mercy (rahmah), as in 1:2 and 105:1.' AS "text_clean"`);
    await out("hadeethenc_items", `SELECT 'hadeethenc:1' AS "node_id", '1' AS "hadeeth_id", 'Deeds are by intentions' AS "title_en", 'إنما الأعمال بالنيات' AS "title_ar", NULL::VARCHAR AS "title_de", 'إنما الأعمال بالنيات' AS "matn_ar", 'Actions are only by intentions.' AS "matn_en", NULL::VARCHAR AS "matn_de", 'Agreed upon' AS "attribution_en", 'Authentic' AS "grade_en", 'Intention is the measure of deeds and of mercy.' AS "explanation_en", 'النية' AS "explanation_ar", NULL::VARCHAR AS "explanation_de", ['Sincerity matters'] AS "hints_benefits", ['The Creed'] AS "categories"`);
    await out("canonical_hadiths", `SELECT 'hadith:bukhari:1' AS "node_id", 'bukhari' AS "collection", 1 AS "hadith_number", 1 AS "book_number", 'إنما الأعمال بالنيات' AS "matn_ar", 'The reward of deeds depends upon the intentions.' AS "matn_en", []::STRUCT(name VARCHAR, grade VARCHAR)[] AS "grades"`);
    await out("collection_books", `SELECT 'bukhari' AS "collection", 1 AS "book_number", 'Revelation' AS "name_en", NULL::VARCHAR AS "name_ar", 1 AS "hadith_first", 7 AS "hadith_last"`);
    await out("categories", `SELECT 'category:the_creed' AS "node_id", 'The Creed' AS "name", '3' AS "hadeethenc_id"`);
    await out("graph_edges", `SELECT * FROM (VALUES
      ('ayah:1:1','surah:1','BELONGS_TO_SURAH','{}'), ('ayah:1:2','surah:1','BELONGS_TO_SURAH','{}'), ('ayah:105:1','surah:105','BELONGS_TO_SURAH','{}'),
      ('tafsir:ibn_kathir_en:1:1','ayah:1:1','EXPLAINS_AYAH','{"coverage":"direct"}'),
      ('tafsir:ibn_kathir_en:1:1','ayah:1:2','EXPLAINS_AYAH','{"coverage":"passage","anchor":"1:1"}'),
      ('tafsir:ibn_kathir_en:1:1','ayah:105:1','CITES_AYAH','{}'),
      ('hadeethenc:1','category:the_creed','IN_CATEGORY','{}')
    ) t(source_id, target_id, edge_type, metadata)`);
    c.closeSync();
    db.closeSync();
    await buildCatalog(dir, () => {});
    corpus = new MihrabCorpus({ dir });
  });
  afterAll(async () => {
    corpus?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("gives every ayah its Tafsir, through passages and citations", async () => {
    const r = await new MihrabRetriever(corpus).retrieve({
      question: "What do the names of mercy, Ar-Rahman, mean?",
      lang: "en",
      persona: "scholar",
    });
    const ids = r.trace.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["ayah:1:1", "tafsir:ibn_kathir_en:1:1", "surah:1"]));
    const explains = r.trace.edges.filter((e) => e.type === "EXPLAINS_AYAH");
    for (const n of r.trace.nodes.filter((n) => n.type === "Ayah" && n.id !== "ayah:105:1"))
      expect(explains.some((e) => e.to === n.id)).toBe(true);
    // 105:1 is cited but has no commentary: the gap is stated, not hidden.
    expect(ids).toContain("ayah:105:1");
    expect(r.trace.notes.join(" ")).toContain("ayah:105:1");
    expect(r.context.find((c) => c.id === "ayah:105:1")?.notes.join(" ")).toMatch(/do not attribute/);
    // Primary texts come back verbatim.
    expect(r.sources["ayah:1:1"].arabic).toBe("بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ");
    expect(r.trace.vector).toBe(false);
  });
  it("attaches grades, Sharh and categories to hadith", async () => {
    const r = await new MihrabRetriever(corpus).retrieve({
      question: "Bukhari 1: actions and intentions",
      lang: "en",
      persona: "scholar",
    });
    expect(r.trace.nodes[0]).toMatchObject({ id: "hadith:bukhari:1", via: expect.arrayContaining(["reference"]) });
    expect(r.sources["hadith:bukhari:1"].grade).toMatchObject({ basis: "collection", label: "Sahih (collection)" });
    expect(r.sources["hadeethenc:1"]).toMatchObject({ grade: { label: "Authentic", basis: "graded" }, benefits: ["Sincerity matters"] });
    expect(r.trace.edges).toContainEqual({ from: "hadeethenc:1", to: "category:the_creed", type: "IN_CATEGORY" });
  });
  it("searches Arabic without diacritics", async () => {
    const hits = await new MihrabRetriever(corpus).bm25("ar", "الرحمن");
    expect(hits[0].node_id).toBe("ayah:1:1");
  });
  it("serves the sources as books, chapters, search hits and locations", async () => {
    const library = new MihrabLibrary(corpus);
    const books = await library.books("en");
    expect(Object.fromEntries(books.map((b) => [b.id, b.total]))).toMatchObject({
      quran: 3,
      "tafsir-ibn-kathir": 1,
      hadeethenc: 1,
      bukhari: 1,
    });
    const fatiha = await library.chapter("quran", "1", { lang: "de" });
    expect(fatiha.items.map((i) => i.source.node_id)).toEqual(["ayah:1:1", "ayah:1:2"]);
    expect(fatiha.items[0].source.translation?.de).toContain("Allerbarmers");
    expect(fatiha.next?.id).toBe("105");
    // A Tafsir passage comes with every ayah it covers, verbatim.
    const tafsir = await library.chapter("tafsir-ibn-kathir", "1", { lang: "en" });
    expect(tafsir.items[0].ayahs?.map((a) => a.node_id)).toEqual(["ayah:1:1", "ayah:1:2"]);
    expect((await library.chapter("bukhari", "1", { lang: "en" })).items[0].source.title).toBe("Sahih al-Bukhari 1");
    expect((await library.search("quran", "merciful", "en"))[0]).toMatchObject({ node_id: "ayah:1:1", chapter: "1" });
    expect(await library.locate("hadeethenc:1", "en")).toEqual({ book: "hadeethenc", chapter: "the_creed" });
    expect(await library.locate("tafsir:ibn_kathir_en:1:1", "en")).toEqual({ book: "tafsir-ibn-kathir", chapter: "1" });
    await expect(library.chapter("quran", "99", { lang: "en" })).rejects.toThrow(/Chapter not found/);
  });
  it("saves chats, continues them with their own context, and reopens them with sources", async () => {
    const seen: any[] = [];
    const env = {
      AZURE_FOUNDRY_ENDPOINT: "https://res.services.ai.azure.com/anthropic/v1/messages",
      AZURE_FOUNDRY_API_KEY: "k",
      AZURE_FOUNDRY_DEPLOYMENTS: "claude-sonnet-5",
    };
    const answer = (text: string) => [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }];
    let reply = answer("Ar-Rahman is a name of mercy [ayah:1:1].");
    const router = new LLMProviderRouter(env, "http://ollama", fetch, ((base: string, key: string) =>
      fakeClaude(reply, { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }, seen)(base, key)) as any);
    const own = new MihrabCorpus({ dir });
    const app = await createApp(new MemoryStore(), { mihrab: { corpus: own, retriever: new MihrabRetriever(own), router } });
    const events = (body: string) =>
      body
        .split("\n\n")
        .filter((b) => b.startsWith("data: "))
        .map((b) => JSON.parse(b.slice(6)));
    const ask = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/mihrab/ask",
        payload: { persona: "explorer", lang: "en", provider: "azure_foundry", model: "claude-sonnet-5", ...payload },
      });

    const first = events((await ask({ question: "What do the names of mercy, Ar-Rahman, mean?" })).body);
    const convo = first.find((e) => e.type === "conversation");
    expect(convo).toMatchObject({ created: true, title: "What do the names of mercy, Ar-Rahman, mean?" });
    expect(first.at(-1).type).toBe("done");

    reply = answer("Mercy also appears in hadith [hadeethenc:1].");
    const second = events((await ask({ question: "And in hadith?", conversationId: convo.id })).body);
    expect(second.find((e) => e.type === "conversation")).toMatchObject({ id: convo.id, created: false });
    // The server gave the model the saved first turn as context.
    expect(seen[1].params.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(seen[1].params.messages[1].content).toContain("Ar-Rahman is a name of mercy");

    const list = (await app.inject({ url: "/api/mihrab/conversations" })).json();
    expect(list).toMatchObject([{ id: convo.id, turns: 2 }]);
    expect((await app.inject({ url: "/api/mihrab/conversations?q=hadith" })).json()).toHaveLength(1);
    expect((await app.inject({ url: "/api/mihrab/conversations?q=zakat" })).json()).toHaveLength(0);

    const opened = (await app.inject({ url: `/api/mihrab/conversations/${convo.id}` })).json();
    expect(opened.turns.map((t: any) => [t.question, t.status])).toEqual([
      ["What do the names of mercy, Ar-Rahman, mean?", "done"],
      ["And in hadith?", "done"],
    ]);
    expect(opened.turns[0].done.citations.valid).toEqual(["ayah:1:1"]);
    // Sources come back verbatim from the corpus, not from the saved record.
    expect(opened.turns[0].sources["ayah:1:1"].arabic).toBe("بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ");

    expect((await app.inject({ method: "PATCH", url: `/api/mihrab/conversations/${convo.id}`, payload: { title: "Mercy" } })).json()).toMatchObject({ title: "Mercy" });
    expect((await app.inject({ method: "DELETE", url: `/api/mihrab/conversations/${convo.id}` })).json()).toEqual({ ok: true });
    expect((await app.inject({ url: "/api/mihrab/conversations" })).json()).toEqual([]);
    expect((await app.inject({ url: `/api/mihrab/conversations/${convo.id}` })).statusCode).toBe(404);
    expect((await ask({ question: "Continue?", conversationId: convo.id })).statusCode).toBe(404);
    own.close();
  });
  it("describes Ring 1 as a valid Foundry bundle", () => {
    const ids = Object.fromEntries(
      ["ring1_surahs", "ring1_ayahs", "ring1_tafsir", "ring1_hadeethenc", "ring1_canonical_hadith", "ring1_categories", "ring1_explains_ayah", "ring1_cites_ayah", "ring1_in_category"].map((n) => [n, "ds_" + n]),
    );
    const b = BundleSchema.parse(ring1Bundle(ids));
    const types = new Set(b.ontology.map((t) => t.name));
    for (const r of b.relationships) expect(types.has(r.fromType) && types.has(r.toType)).toBe(true);
    expect(b.actions).toEqual([]);
  });
});

describe("reading progress", () => {
  it("merges what has been on screen into ranges", () => {
    expect(mergeRanges([[10, 12], [0, 3], [4, 5], [11, 20]])).toEqual([[0, 5], [10, 20]]);
  });
});
