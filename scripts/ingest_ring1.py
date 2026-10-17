"""The Ring 1 Golden Corpus Builder.

Fetches the Qur'an (Uthmani Arabic + Sahih International EN + Bubenheim DE),
Tafsir Ibn Kathir (EN), HadeethEnc (AR/EN/DE with Sharh) and the canonical
collections (Bukhari, Muslim, Nawawi 40), and writes them as Parquet + JSONL
plus a DuckDB file under ./data/ring1_golden_corpus/ (relative to the
repository root, whatever the working directory).

    python3 scripts/ingest_ring1.py            # HadeethEnc capped at 300 items
    python3 scripts/ingest_ring1.py --full     # every HadeethEnc item (~3,500)
"""

import argparse
import asyncio
import html
import json
import os
import re
from pathlib import Path
from typing import List, Optional, Dict, Any, Set

import duckdb
import httpx
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, Field
from tenacity import retry, stop_after_attempt, wait_exponential
from tqdm.asyncio import tqdm

# =====================================================================
# 1. CONFIGURATION & OUTPUT PATHS
# =====================================================================
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("MIHRAB_CORPUS_DIR", ROOT / "data" / "ring1_golden_corpus"))
PARQUET_DIR = DATA_DIR / "parquet"
JSONL_DIR = DATA_DIR / "jsonl"

for d in (PARQUET_DIR, JSONL_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Concurrency limit for polite API fetching
SEMAPHORE = asyncio.Semaphore(12)

# Explicit Surah:Ayah references like (2:255) or [112:1]. Surahs 100-114 are
# listed first so "105:3" is not cut down to "10"; matches are then checked
# against the real ayah list, which drops times and page numbers.
AYAH_REF_REGEX = re.compile(r"(?<![\d:])(11[0-4]|10\d|[1-9]\d?):([1-9]\d{0,2})(?![\d:])")


# =====================================================================
# 2. PYDANTIC SCHEMAS (IMMUTABLE NODE & EDGE DEFINITIONS)
# =====================================================================
class SurahNode(BaseModel):
    node_id: str = Field(..., description="e.g., surah:2")
    surah_number: int
    name_ar: str
    name_en: str
    name_translation_en: str
    revelation_place: str
    ayah_count: int


class AyahNode(BaseModel):
    node_id: str = Field(..., description="Unique Graph Node ID, e.g., ayah:2:255")
    ayah_key: str = Field(..., description="Surah:Ayah format, e.g., 2:255")
    surah_number: int
    ayah_number: int
    surah_name_ar: str
    surah_name_en: str
    revelation_place: str  # Meccan / Medinan
    juz_number: int
    hizb_number: int
    text_uthmani: str  # Immutable Arabic primary text
    translation_en: str  # Sahih International
    translation_de: str  # Bubenheim & Elyas (Official KFGQPC German)


class TafsirNode(BaseModel):
    node_id: str = Field(..., description="e.g., tafsir:ibn_kathir_en:2:255")
    ayah_key: str
    source_slug: str
    author_name: str
    language: str
    text_clean: str


class HadeethEncNode(BaseModel):
    node_id: str = Field(..., description="e.g., hadeethenc:3142")
    hadeeth_id: str
    title_en: str
    title_ar: str
    title_de: Optional[str] = None
    matn_ar: str  # Immutable Arabic Hadith text
    matn_en: str
    matn_de: Optional[str] = None
    attribution_en: str
    grade_en: str  # Sahih, Hasan, etc.
    explanation_en: str  # Peer-reviewed Sharh
    explanation_ar: str
    explanation_de: Optional[str] = None
    hints_benefits: List[str] = Field(default_factory=list)  # Fawa'id
    categories: List[str] = Field(default_factory=list)


class CanonicalHadithNode(BaseModel):
    node_id: str = Field(..., description="e.g., hadith:bukhari:1")
    collection: str  # bukhari, muslim, nawawi40
    hadith_number: int
    book_number: int
    matn_ar: str
    matn_en: str
    grades: List[Dict[str, str]] = Field(default_factory=list)


class CategoryNode(BaseModel):
    node_id: str = Field(..., description="e.g., category:the_creed")
    name: str
    hadeethenc_id: str


class CollectionBook(BaseModel):
    collection: str  # bukhari, muslim, nawawi40
    book_number: int
    name_en: str
    name_ar: Optional[str] = None
    hadith_first: int
    hadith_last: int


class GraphEdge(BaseModel):
    source_id: str
    target_id: str
    edge_type: str  # EXPLAINS_AYAH, BELONGS_TO_SURAH, CITES_AYAH, IN_CATEGORY
    metadata: str = "{}"


# =====================================================================
# 3. HELPER FUNCTIONS
# =====================================================================
BLOCK_TAG_RE = re.compile(r"</?(?:h\d|p|div|br|li|ul|ol|blockquote)[^>]*>", re.I)
HTML_TAG_RE = re.compile(r"<[^>]+>")


def strip_html(text: Optional[str]) -> str:
    """Drop markup but keep paragraph breaks, so headings stay separate."""
    if not text:
        return ""
    text = BLOCK_TAG_RE.sub("\n", text)
    text = html.unescape(HTML_TAG_RE.sub("", text))
    lines = (re.sub(r"[ \t ]+", " ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def save_dataset(records: List[BaseModel], name: str) -> None:
    if not records:
        print(f"⚠️ No records to save for {name}")
        return
    dicts = [r.model_dump() for r in records]

    # Save JSONL for Helix Foundry text/document pipelines
    jsonl_path = JSONL_DIR / f"{name}.jsonl"
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for d in dicts:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")

    # Save Parquet for instant DuckDB / HelixDB zero-copy ingestion
    parquet_path = PARQUET_DIR / f"{name}.parquet"
    table = pa.Table.from_pylist(dicts)
    pq.write_table(table, parquet_path, compression="zstd")
    print(f"✅ Saved {len(records):,} records -> {parquet_path} & {jsonl_path}")


@retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=1, min=2, max=10))
async def fetch_json(client: httpx.AsyncClient, url: str, params: dict = None) -> Any:
    async with SEMAPHORE:
        resp = await client.get(url, params=params, timeout=30.0)
        resp.raise_for_status()
        return resp.json()


# =====================================================================
# 4. MODULE A: QUR'AN (ARABIC UTHMANI + EN + DE) & TAFSIR (QUL / QF API v4)
# =====================================================================
async def ingest_quran_and_tafsir(client: httpx.AsyncClient, edges: List[GraphEdge]):
    print("\n📖 [1/4] Fetching Qur'an (Uthmani + EN + DE) from AlQuran Cloud / Tanzil...")
    # Fetch complete editions in 3 calls instead of 6,236 calls
    ar_data, en_data, de_data = await asyncio.gather(
        fetch_json(client, "https://api.alquran.cloud/v1/quran/quran-uthmani"),
        fetch_json(client, "https://api.alquran.cloud/v1/quran/en.sahih"),
        fetch_json(client, "https://api.alquran.cloud/v1/quran/de.bubenheim"),
    )

    ayah_nodes: List[AyahNode] = []
    surah_nodes: List[SurahNode] = []
    ar_surahs = ar_data["data"]["surahs"]
    en_surahs = en_data["data"]["surahs"]
    de_surahs = de_data["data"]["surahs"]

    for s_idx, surah in enumerate(ar_surahs):
        s_num = surah["number"]
        s_name_ar = surah["name"]
        s_name_en = surah["englishName"]
        rev_type = surah["revelationType"]
        surah_nodes.append(
            SurahNode(
                node_id=f"surah:{s_num}",
                surah_number=s_num,
                name_ar=s_name_ar,
                name_en=s_name_en,
                name_translation_en=surah.get("englishNameTranslation", ""),
                revelation_place=rev_type,
                ayah_count=len(surah["ayahs"]),
            )
        )

        for a_idx, ayah_ar in enumerate(surah["ayahs"]):
            a_num = ayah_ar["numberInSurah"]
            ayah_key = f"{s_num}:{a_num}"
            node_id = f"ayah:{ayah_key}"

            ayah_en = en_surahs[s_idx]["ayahs"][a_idx]["text"]
            ayah_de = de_surahs[s_idx]["ayahs"][a_idx]["text"]

            ayah_nodes.append(
                AyahNode(
                    node_id=node_id,
                    ayah_key=ayah_key,
                    surah_number=s_num,
                    ayah_number=a_num,
                    surah_name_ar=s_name_ar,
                    surah_name_en=s_name_en,
                    revelation_place=rev_type,
                    juz_number=ayah_ar["juz"],
                    hizb_number=ayah_ar["hizbQuarter"],
                    text_uthmani=ayah_ar["text"],
                    translation_en=ayah_en,
                    translation_de=ayah_de,
                )
            )
            edges.append(
                GraphEdge(
                    source_id=node_id,
                    target_id=f"surah:{s_num}",
                    edge_type="BELONGS_TO_SURAH",
                )
            )

    save_dataset(surah_nodes, "surahs")
    save_dataset(ayah_nodes, "quran_ayahs")
    ayah_keys: Set[str] = {a.ayah_key for a in ayah_nodes}

    # Fetch Classical Tafsir Ibn Kathir (Abridged EN, ID: 169) from Quran.com v4 API
    print("📚 [2/4] Fetching Classical Tafsir (Ibn Kathir EN) across all 114 Surahs...")
    tafsir_nodes: List[TafsirNode] = []
    TAFSIR_ID = 169  # Ibn Kathir (Abridged English) on Quran.com API v4
    # Ibn Kathir comments on passages: the text sits on the passage's first
    # ayah and the following ayahs come back empty. Keep every verse key so
    # those ayahs can be linked to the passage that explains them.
    seen: Dict[str, bool] = {}

    async def fetch_surah_tafsir(surah_num: int):
        url = f"https://api.quran.com/api/v4/tafsirs/{TAFSIR_ID}/by_chapter/{surah_num}"
        page = 1
        while True:
            data = await fetch_json(client, url, params={"page": page, "per_page": 50})
            for item in data.get("tafsirs", []):
                v_key = item.get("verse_key")
                if not v_key:
                    continue
                clean_txt = strip_html(item.get("text", ""))
                seen[v_key] = bool(clean_txt)
                if not clean_txt:
                    continue
                t_id = f"tafsir:ibn_kathir_en:{v_key}"
                tafsir_nodes.append(
                    TafsirNode(
                        node_id=t_id,
                        ayah_key=v_key,
                        source_slug="ibn_kathir_en",
                        author_name="Hafiz Ibn Kathir",
                        language="en",
                        text_clean=clean_txt,
                    )
                )
                # Direct link to explained Ayah
                edges.append(
                    GraphEdge(
                        source_id=t_id,
                        target_id=f"ayah:{v_key}",
                        edge_type="EXPLAINS_AYAH",
                        metadata=json.dumps({"coverage": "direct"}),
                    )
                )
                # Extract cross-referenced Ayahs inside Ibn Kathir's commentary
                for ref_key in dict.fromkeys(f"{s}:{a}" for s, a in AYAH_REF_REGEX.findall(clean_txt)):
                    if ref_key != v_key and ref_key in ayah_keys:
                        edges.append(
                            GraphEdge(
                                source_id=t_id,
                                target_id=f"ayah:{ref_key}",
                                edge_type="CITES_AYAH",
                            )
                        )
            pagination = data.get("pagination", {})
            if not pagination.get("next_page"):
                break
            page = pagination["next_page"]

    await tqdm.gather(*(fetch_surah_tafsir(s) for s in range(1, 115)), desc="Tafsir Surahs")

    # Link each empty ayah to the passage commentary that precedes it in its surah.
    passage_links = 0
    for ayah in ayah_nodes:
        if seen.get(ayah.ayah_key, False):
            continue
        for prev in range(ayah.ayah_number - 1, 0, -1):
            anchor = f"{ayah.surah_number}:{prev}"
            if seen.get(anchor):
                edges.append(
                    GraphEdge(
                        source_id=f"tafsir:ibn_kathir_en:{anchor}",
                        target_id=ayah.node_id,
                        edge_type="EXPLAINS_AYAH",
                        metadata=json.dumps({"coverage": "passage", "anchor": anchor}),
                    )
                )
                passage_links += 1
                break
    print(f"🔗 Linked {passage_links:,} ayahs to the passage commentary that covers them.")
    save_dataset(tafsir_nodes, "tafsir_entries")


# =====================================================================
# 5. MODULE B: HADEETHENC (SCHOLAR-VERIFIED SHARH IN AR / EN / DE)
# =====================================================================
async def ingest_hadeethenc(client: httpx.AsyncClient, edges: List[GraphEdge], limit: Optional[int]):
    print("\n🕌 [3/4] Fetching HadeethEnc Categories & Verified Hadiths (AR/EN/DE)...")
    base_url = "https://hadeethenc.com/api/v1"
    categories = await fetch_json(client, f"{base_url}/categories/roots/", params={"language": "en"})
    save_dataset(
        [CategoryNode(node_id=f"category:{slugify(c['title'])}", name=c["title"], hadeethenc_id=str(c["id"])) for c in categories],
        "categories",
    )

    # Collect unique Hadeeth IDs across root categories (Aqeedah, Fiqh, Seerah, Adab)
    hadeeth_id_to_cats: Dict[str, List[str]] = {}

    async def fetch_cat_hadiths(cat_id: str, cat_title: str):
        page = 1
        while True:
            res = await fetch_json(
                client,
                f"{base_url}/hadeeths/list/",
                params={"language": "en", "category_id": cat_id, "page": page, "per_page": 100},
            )
            data_list = res.get("data", [])
            if not data_list:
                break
            for item in data_list:
                hid = str(item["id"])
                hadeeth_id_to_cats.setdefault(hid, []).append(cat_title)
            meta = res.get("meta", {})
            if int(meta.get("current_page", 1)) >= int(meta.get("last_page", 1)):
                break
            page += 1

    await asyncio.gather(*(fetch_cat_hadiths(c["id"], c["title"]) for c in categories))
    print(f"Found {len(hadeeth_id_to_cats):,} unique annotated Hadiths across root domains.")

    hadeeth_nodes: List[HadeethEncNode] = []
    failures: List[str] = []

    async def fetch_single_hadeeth(hid: str, cat_names: List[str]):
        try:
            en_d, ar_d, de_d = await asyncio.gather(
                fetch_json(client, f"{base_url}/hadeeths/one/", params={"language": "en", "id": hid}),
                fetch_json(client, f"{base_url}/hadeeths/one/", params={"language": "ar", "id": hid}),
                fetch_json(client, f"{base_url}/hadeeths/one/", params={"language": "de", "id": hid}),
                return_exceptions=True,
            )
            if isinstance(en_d, Exception) or isinstance(ar_d, Exception):
                failures.append(hid)
                return

            node_id = f"hadeethenc:{hid}"
            de_ok = not isinstance(de_d, Exception) and isinstance(de_d, dict)

            node = HadeethEncNode(
                node_id=node_id,
                hadeeth_id=hid,
                title_en=en_d.get("title") or "",
                title_ar=ar_d.get("title") or "",
                title_de=de_d.get("title") if de_ok else None,
                matn_ar=ar_d.get("hadeeth") or en_d.get("hadeeth_ar") or "",
                matn_en=en_d.get("hadeeth") or "",
                matn_de=de_d.get("hadeeth") if de_ok else None,
                attribution_en=en_d.get("attribution") or "",
                grade_en=en_d.get("grade") or "",
                explanation_en=en_d.get("explanation") or "",
                explanation_ar=ar_d.get("explanation") or en_d.get("explanation_ar") or "",
                explanation_de=de_d.get("explanation") if de_ok else None,
                hints_benefits=[h.strip() for h in en_d.get("hints") or [] if h and h.strip()],
                categories=cat_names,
            )
            hadeeth_nodes.append(node)

            # Link Hadith to Domain Categories
            for c_name in cat_names:
                edges.append(
                    GraphEdge(
                        source_id=node_id,
                        target_id=f"category:{slugify(c_name)}",
                        edge_type="IN_CATEGORY",
                    )
                )
        except Exception as e:  # keep going, but report what was skipped
            failures.append(f"{hid} ({type(e).__name__})")

    target_items = list(hadeeth_id_to_cats.items())
    if limit is not None:
        target_items = target_items[:limit]
    await tqdm.gather(*(fetch_single_hadeeth(hid, cats) for hid, cats in target_items), desc="HadeethEnc Items")
    if failures:
        print(f"⚠️ Skipped {len(failures)} HadeethEnc items: {', '.join(failures[:10])}{' …' if len(failures) > 10 else ''}")
    save_dataset(hadeeth_nodes, "hadeethenc_items")


# =====================================================================
# 6. MODULE C: CANONICAL HADITH (BUKHARI, MUSLIM, NAWAWI 40)
# =====================================================================
async def ingest_canonical_hadiths(client: httpx.AsyncClient):
    print("\n📜 [4/4] Fetching Canonical Hadith Collections (Bukhari, Muslim, Nawawi 40)...")
    cdn_base = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions"
    collections = [
        ("bukhari", "ara-bukhari.min.json", "eng-bukhari.min.json"),
        ("muslim", "ara-muslim.min.json", "eng-muslim.min.json"),
        ("nawawi40", "ara-nawawi.min.json", "eng-nawawi.min.json"),
    ]

    canonical_nodes: List[CanonicalHadithNode] = []

    for slug, ar_file, en_file in collections:
        ar_json, en_json = await asyncio.gather(
            fetch_json(client, f"{cdn_base}/{ar_file}"),
            fetch_json(client, f"{cdn_base}/{en_file}"),
        )
        ar_map = {h["hadithnumber"]: h for h in ar_json.get("hadiths", [])}
        for h_en in en_json.get("hadiths", []):
            h_num = h_en.get("hadithnumber")
            if not isinstance(h_num, int):
                continue
            h_ar = ar_map.get(h_num, {})
            matn_ar = h_ar.get("text", "").strip()
            matn_en = h_en.get("text", "").strip()
            if not matn_ar and not matn_en:
                continue

            canonical_nodes.append(
                CanonicalHadithNode(
                    node_id=f"hadith:{slug}:{h_num}",
                    collection=slug,
                    hadith_number=h_num,
                    book_number=h_en.get("reference", {}).get("book", 0),
                    matn_ar=matn_ar,
                    matn_en=matn_en,
                    grades=[{"name": str(g.get("name", "")), "grade": str(g.get("grade", ""))} for g in h_en.get("grades", [])],
                )
            )

    save_dataset(canonical_nodes, "canonical_hadiths")


async def ingest_collection_books(client: httpx.AsyncClient):
    """Book (kitab) names and hadith ranges, for reading the collections."""
    print("\n📚 Fetching the book names of each canonical collection...")
    cdn_base = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions"
    arabic = re.compile(r"[\u0600-\u06FF]")
    books: List[CollectionBook] = []
    for slug, ar_file, en_file in (
        ("bukhari", "ara-bukhari.min.json", "eng-bukhari.min.json"),
        ("muslim", "ara-muslim.min.json", "eng-muslim.min.json"),
        ("nawawi40", "ara-nawawi.min.json", "eng-nawawi.min.json"),
    ):
        ar_json, en_json = await asyncio.gather(
            fetch_json(client, f"{cdn_base}/{ar_file}"), fetch_json(client, f"{cdn_base}/{en_file}")
        )
        meta, ar_names = en_json.get("metadata", {}), ar_json.get("metadata", {}).get("sections", {})
        details = meta.get("section_details", {})
        for num, name in meta.get("sections", {}).items():
            d = details.get(num, {})
            first, last = int(d.get("hadithnumber_first") or 0), int(d.get("hadithnumber_last") or 0)
            if not last:
                continue
            ar = ar_names.get(num) or ""
            books.append(
                CollectionBook(
                    collection=slug,
                    book_number=int(num),
                    name_en=name or meta.get("name", slug),
                    name_ar=ar if arabic.search(ar) else None,
                    hadith_first=first,
                    hadith_last=last,
                )
            )
    save_dataset(books, "collection_books")


# =====================================================================
# 7. MAIN PIPELINE & DUCKDB VERIFICATION
# =====================================================================
TABLES = [
    "surahs",
    "quran_ayahs",
    "tafsir_entries",
    "hadeethenc_items",
    "canonical_hadiths",
    "categories",
    "collection_books",
    "graph_edges",
]


async def main(limit: Optional[int]):
    edges: List[GraphEdge] = []
    async with httpx.AsyncClient(headers={"User-Agent": "HelixFoundry-IslamicKG/1.0"}) as client:
        await ingest_quran_and_tafsir(client, edges)
        await ingest_hadeethenc(client, edges, limit)
        await ingest_canonical_hadiths(client)
        await ingest_collection_books(client)

    # The same edge can be found twice (a hadith listed under one root twice).
    unique = {(e.source_id, e.target_id, e.edge_type): e for e in edges}
    save_dataset(list(unique.values()), "graph_edges")

    # Quick DuckDB inspection to verify our relational & graph integrity
    print("\n🔍 Running DuckDB Integrity Check on Parquet Corpus...")
    con = duckdb.connect(database=str(DATA_DIR / "ring1_knowledge.duckdb"))
    for t in TABLES:
        con.execute(f"CREATE OR REPLACE TABLE {t} AS SELECT * FROM '{PARQUET_DIR}/{t}.parquet';")

    summary = con.execute("""
        SELECT 'Surahs' AS table_name, COUNT(*) AS rows FROM surahs
        UNION ALL
        SELECT 'Quran Ayahs (AR/EN/DE)', COUNT(*) FROM quran_ayahs
        UNION ALL
        SELECT 'Classical Tafsir (Ibn Kathir)', COUNT(*) FROM tafsir_entries
        UNION ALL
        SELECT 'HadeethEnc (AR/EN/DE + Sharh)', COUNT(*) FROM hadeethenc_items
        UNION ALL
        SELECT 'Canonical Hadiths (Bukhari/Muslim/Nawawi)', COUNT(*) FROM canonical_hadiths
        UNION ALL
        SELECT 'HadeethEnc Root Categories', COUNT(*) FROM categories
        UNION ALL
        SELECT 'Deterministic Graph Edges', COUNT(*) FROM graph_edges;
    """).fetchall()

    print("\n📊 RING 1 GOLDEN CORPUS SUMMARY:")
    for table_name, count in summary:
        print(f"  • {table_name:<42}: {count:>8,}")
    for edge_type, count in con.execute(
        "SELECT edge_type, COUNT(*) FROM graph_edges GROUP BY 1 ORDER BY 1"
    ).fetchall():
        print(f"    ↳ {edge_type:<40}: {count:>8,}")
    uncovered = con.execute("""
        SELECT COUNT(*) FROM quran_ayahs a WHERE NOT EXISTS (
          SELECT 1 FROM graph_edges e WHERE e.edge_type = 'EXPLAINS_AYAH' AND e.target_id = a.node_id)
    """).fetchone()[0]
    print(f"  • Ayahs without a Tafsir node              : {uncovered:>8,}")
    con.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full", action="store_true", help="fetch every HadeethEnc item")
    parser.add_argument("--hadeethenc-limit", type=int, default=300, help="HadeethEnc items to fetch (default 300)")
    parser.add_argument("--books-only", action="store_true", help="only (re)fetch the collections' book names")
    args = parser.parse_args()
    if args.books_only:
        async def books_only():
            async with httpx.AsyncClient(headers={"User-Agent": "HelixFoundry-IslamicKG/1.0"}) as client:
                await ingest_collection_books(client)
        asyncio.run(books_only())
    else:
        asyncio.run(main(None if args.full else args.hadeethenc_limit))
