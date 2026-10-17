# Mihrab (مِحْرَاب)

Mihrab is a grounded Islamic knowledge workspace built into this Helix Foundry checkout. It answers questions from a fixed corpus, the **Ring 1 golden corpus**, through mandatory multi-hop graph retrieval. Every statement cites the node it rests on, and Qur'an and hadith texts are always shown verbatim from the corpus, never written by a model.

Open it at **http://localhost:5173/mihrab** (development) or **http://localhost:3001/mihrab** (Docker).

## Quick start

```sh
pnpm install
./scripts/setup.sh               # .env with Foundry's keys; never overwrites an existing one
pnpm mihrab:seed                 # corpus (if missing) → DuckDB catalog → embeddings
pnpm dev                         # needs the development HelixDB (AGENTS.md → Development setup)
```

- `pnpm mihrab:seed --rebuild --full` re-fetches the corpus with every HadeethEnc item. Without `--full`, the builder keeps its original cap of 300 items.
- `pnpm mihrab:seed --no-embed` skips embeddings. Retrieval then uses BM25 only, and the UI says so.
- `pnpm mihrab:seed --foundry [--publish]`, with the app running, registers Ring 1 in a Foundry workspace named "Mihrab — Ring 1" as HelixDB object types and relationships. Without `--publish`, it leaves a validated proposal for you to review under Reviews.
- `pnpm mihrab:palette [image-url]` regenerates `apps/web/src/styles/mihrab-theme.css` from the reference image.

Embeddings need `ollama pull nomic-embed-text-v2-moe`. The model is multilingual, so German and Arabic questions reach English passages. The run is resumable: re-running `pnpm mihrab:seed` continues where it stopped.

Rebuilding the catalog needs a write lock on the DuckDB file, so stop `pnpm dev` first. The seed skips the rebuild when the catalog is newer than every Parquet table, which is why `--foundry` works while the app is running.

### Models

Set these in `.env` (Compose passes them to the app container):

| Variable                    | Meaning                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AZURE_FOUNDRY_ENDPOINT`    | The Azure AI Foundry resource, as `https://NAME.services.ai.azure.com` or any of its API URLs (`…/anthropic/v1/messages`, `…/models`, `…/openai/v1`). HTTPS only.                             |
| `AZURE_FOUNDRY_API_KEY`     | Never logged. Redirects are refused, so the key cannot be forwarded.                                                                                                                            |
| `AZURE_FOUNDRY_DEPLOYMENTS` | Comma-separated deployment names. Names containing `claude` go through Anthropic's Messages API (the official `@anthropic-ai/foundry-sdk`); the rest use chat completions on the same resource. |
| `AZURE_FOUNDRY_API_VERSION` | For chat-completions deployments. Default `2024-10-21`.                                                                                                                                         |
| `MIHRAB_CLAUDE_EFFORT`      | Optional effort for Claude (`low` … `max`). Unset uses the model's default.                                                                                                                     |
| `MIHRAB_DEFAULT_PROVIDER` / `MIHRAB_DEFAULT_MODEL` | The model to preselect.                                                                                                                                                  |

Claude runs with adaptive thinking. Its reasoning is never shown; the UI shows a "reasoning…" phase. The system prompt is sent as a cached block, and a refusal (`stop_reason: refusal`) is reported as an error rather than as an empty answer.

Ollama models are detected from `/api/tags` at `OLLAMA_URL` (`MODEL_ENDPOINT` in Docker). For thinking models (qwen3), the router asks Ollama to keep reasoning out of the answer, since some builds reason even with `think: false`.

### Embeddings

| Variable                              | Meaning                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `MIHRAB_EMBED_PROVIDER`               | `ollama` (default, `nomic-embed-text-v2-moe`) or `azure_foundry`             |
| `AZURE_FOUNDRY_EMBEDDINGS_ENDPOINT`   | The resource, for example `https://NAME.services.ai.azure.com`               |
| `AZURE_FOUNDRY_EMBEDDINGS_KEY`        | Its key                                                                       |
| `AZURE_FOUNDRY_EMBEDDINGS_DEPLOYMENT` | The deployment name (not the model name), for example `embedding`            |
| `AZURE_FOUNDRY_EMBEDDINGS_DIMENSIONS` | Default `1024` (text-embedding-3 shortens vectors); `full` keeps the model's size |

Build an embedder's vectors with `pnpm mihrab:seed --embed-provider azure_foundry` (or `ollama`). Each embedder writes to its own folder under `data/ring1_golden_corpus/embeddings/`, so both can exist at once. The app searches the vectors of `MIHRAB_EMBED_PROVIDER`, and answers say "BM25 only" until those vectors exist. Questions are embedded with the same embedder at query time, so with Azure every question makes one embeddings call.

### Measuring retrieval

`pnpm mihrab:eval [--misses]` scores Stage 1 on `scripts/mihrab_eval_set.json`: 46 questions in English, German and Arabic, each with the nodes it should find. It reports BM25 alone, and each built embedder alone and fused with BM25, as Hit@3, Hit@10, MRR and recall (overall and per language). A Tafsir passage that explains a gold ayah counts as finding it, because Stage 2 brings the ayah along. `--misses` lists what each setup failed to find. Extend the set when you change retrieval; it is a small, hand-checked set, so treat differences of one or two questions as noise.

## Library

**Library** in the top bar (`/mihrab/library`) has six books: the Qur'an (by surah), Tafsir Ibn Kathir (by surah, each passage beside the verses it covers), HadeethEnc (by subject), and Sahih al-Bukhari, Sahih Muslim and an-Nawawi's Forty (by book).

- **Same text as answers.** Every text is served verbatim from the corpus, the same records answers cite.
- **The reader.** It has a contents sidebar with per-chapter progress, an estimate of the reading time left, bookmarks, search within the book, text size and an Arabic toggle, previous and next chapter, and full screen.
- **Asking from the reader.** ✦ **Summarize** and **Ask about this chapter** send a question to the Ask view, and every verse or hadith has its own *Ask about this*. In the Ask view, the source inspector's **Open in Library** opens the passage in context.
- **Stored in this browser.** Progress counts only passages that were actually on screen; jumping to a verse does not mark the chapter read. Progress, bookmarks and the last position are kept in this browser's local storage.
- **Book names.** Bukhari's and Muslim's book (kitab) names come from `collection_books` (`python3 scripts/ingest_ring1.py --books-only` backfills it for an existing corpus). Each hadith is placed by its own reference, since the source's book ranges overlap. Six Bukhari hadiths have no book in the source and are not shown in the reader.

API: `GET /api/mihrab/library`, `GET /api/mihrab/library/:book`, `GET /api/mihrab/library/:book/:chapter?offset=&around=NODE_ID`, `GET /api/mihrab/library/:book/search?q=`, and `GET /api/mihrab/locate/:nodeId`.

## Chat history

The Ask view's sidebar lists saved chats, newest first, grouped by day. You can search them (titles and questions), rename or delete them, and start a new chat. Each chat has its own address (`/mihrab/c/<id>`). The sidebar collapses to a narrow strip and opens as a drawer on small screens.

- **Where chats are kept.** They are stored in Foundry's store (HelixDB in Docker), in a `mihrab` scope of their own, so they are in Foundry's backups.
- **What is saved.** The server saves each answer when its stream ends, whether it finished, failed or was stopped, even if the page was closed meanwhile.
- **What a turn keeps.** The question, the answer, the model, timings, the citation checks and the retrieval trace. Source texts are not stored; reopening a chat rebuilds them verbatim from the corpus by node id.
- **Context.** For a saved chat, the server gives the model the last three finished turns, read from the store. A follow-up that is short or refers back ("…about its virtue?") is searched together with the previous question.

API: `GET /api/mihrab/conversations?q=`, `GET /api/mihrab/conversations/:id`, `PATCH /api/mihrab/conversations/:id` (`{ title }`), `DELETE /api/mihrab/conversations/:id`. `POST /api/mihrab/ask` takes an optional `conversationId`, and its first event is `conversation` (`{ id, title, created }`).

## Voice input

Every place a question is typed has a microphone: the Ask composer, the reader's ask box and the book search. Speech is transcribed by the browser's Web Speech API in the interface language (en-US, de-DE, ar-SA) into the text field, for you to review and send. Answers are always text.

The Web Speech API works in Chrome, Edge and Safari; elsewhere the button is disabled with an explanation. In Chrome and Edge, the browser vendor's speech service does the recognition, so audio leaves the computer. Safari on macOS can recognise speech on the device.

## Theme

`pnpm mihrab:palette` extracts light mode from the stone-and-cobalt reference image and dark mode from `docs/assets/mihrab-palette-dark.jpg` (a blue tiled mihrab: lapis navy, turquoise, cobalt and calligraphy gold). It checks WCAG contrast and writes `apps/web/src/styles/mihrab-theme.css`. Pass `--dark PATH_OR_URL` to use another image for dark mode.

## Architecture

| Piece                         | Where                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Corpus builder (Python)       | `scripts/ingest_ring1.py` → `data/ring1_golden_corpus/{parquet,jsonl}/`, `ring1_knowledge.duckdb` |
| Ontology, contract, citations | `packages/shared/src/mihrab.ts`                                                          |
| DuckDB catalog + BM25         | `services/executor/src/mihrab-catalog.ts`                                                |
| Embeddings (Parquet parts)    | `services/executor/src/mihrab-vectors.ts` → `data/ring1_golden_corpus/embeddings/<model>/` |
| Retrieval (3 stages)          | `apps/api/src/services/mihrabRetriever.ts`                                               |
| Prompt + answer checks        | `apps/api/src/services/mihrabPrompt.ts`                                                  |
| Azure Foundry / Ollama router | `apps/api/src/services/llmProviderRouter.ts`                                             |
| Routes                        | `apps/api/src/routes/mihrab.ts`                                                          |
| Foundry/HelixDB registration  | `apps/api/src/services/mihrabFoundry.ts`                                                 |
| Web workspace                 | `apps/web/src/mihrab/` (route `/mihrab`), theme `apps/web/src/styles/mihrab-theme.css`   |
| Library                       | `apps/api/src/services/mihrabLibrary.ts`, `apps/web/src/mihrab/library/`                 |
| Voice input                   | `apps/web/src/mihrab/voice.tsx`                                                          |
| Chat history                  | `apps/api/src/services/mihrabHistory.ts`, `apps/web/src/mihrab/History.tsx`              |
| Tests                         | `tests/mihrab.test.ts`                                                                   |

### Ontology

Nodes: `Surah`, `Ayah`, `TafsirEntry`, `HadeethEncItem`, `CanonicalHadith`, `Category`.
Edges: `BELONGS_TO_SURAH` (Ayah→Surah), `EXPLAINS_AYAH` (TafsirEntry→Ayah, `coverage` = `direct` | `passage`), `CITES_AYAH` (TafsirEntry→Ayah), `IN_CATEGORY` (HadeethEncItem→Category). The catalog stores the ontology itself in `mihrab_node_types` and `mihrab_edge_types`, with each type's immutable fields: `text_uthmani`, `translation_en`, `translation_de`, `matn_ar`, `matn_en` and `matn_de`.

Ibn Kathir comments on passages, so about 70% of ayahs have no entry of their own. The builder links each such ayah to the passage commentary that covers it (`coverage: passage`). Only Surah 105 (al-Fil) has no Tafsir in this edition, and Mihrab states that rather than hiding it.

In Foundry, relationships are column matches, so the many-to-many edges are link object types (`Tafsir Explanation`, `Tafsir Citation`, `Category Membership`), each with a relationship to both ends.

### Retrieval (before any model call)

1. **Hybrid entry points.** BM25 over per-language chunk indexes (English, German and Arabic Snowball stemmers; Arabic is searched without diacritics) is fused by reciprocal rank with vector similarity. Explicit references such as `2:255` or `Bukhari 1` are pinned.
2. **Graph expansion.** Every Ayah brings its TafsirEntry, and that commentary's cited ayahs (`CITES_AYAH`) each bring their own Tafsir. A TafsirEntry brings the ayahs it explains. Hadith bring their grade, attribution, Sharh, benefits and categories.
3. **Grounded synthesis.** The model reads the context and must cite `[node_id]`s from it. It presents verses and hadith only as `{{quote:node_id}}`, which the UI renders as Immutable Source Cards filled from the corpus.

Explorer mode uses a smaller context than Scholar mode.

After the answer, the server reports any citations not in the context, and any 8-word span of a primary text the model copied into its own prose. The UI shows both, and always shows verified cards for every cited verse and hadith.

**Fatwa guardrail.** The system prompt separates scholarship from personal rulings. For marriage, divorce, inheritance, oaths and the like, the model presents the texts and any recorded positions (ijma' / ikhtilaf) with citations, and advises consulting a qualified living scholar. Personal-ruling questions are also detected deterministically and show a notice above the answer.

### Hadith grades

HadeethEnc items carry their own grade. The canonical collections source (`fawazahmed0/hadith-api`) carries no per-hadith grades, so Bukhari and Muslim show **"Ṣaḥīḥ · collection"** (the collection's status), and Nawawi 40 shows "grade not recorded". The model is told not to assert a grade the data does not give.

## HTTP API

| Method / path                | Result                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET `/api/llm/models`        | `{ providers: [{ id, available, reason?, models }], default }`                                       |
| GET `/api/mihrab/status`     | Corpus counts, vector index, ontology                                                                |
| GET `/api/mihrab/nodes/:id`  | `{ source, neighbors }`, verbatim                                                                    |
| POST `/api/mihrab/retrieve`  | `{ question, lang?, persona }` → trace, sources, context (no model)                                  |
| POST `/api/mihrab/ask`       | `{ question, lang?, persona, provider, model, history? }` → server-sent events: `retrieval`, `phase`, `token`, `done` (usage, citation check, verbatim spans), `error` |

These routes are not workspace-scoped (the corpus is read-only and shared) but are subject to Foundry's host and origin checks.
