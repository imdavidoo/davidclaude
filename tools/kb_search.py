#!/usr/bin/env python3
"""KB Search — hybrid keyword + vector search over the knowledge base index."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent

# Load .env if OPENAI_API_KEY not already set
if not os.environ.get("OPENAI_API_KEY"):
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()
INDEX_FILE = ROOT / ".kb-index" / "index.json"


def load_index() -> dict:
    """Load the search index."""
    if not INDEX_FILE.exists():
        print("ERROR: Index not found. Run: python3 tools/kb_index.py", file=sys.stderr)
        sys.exit(1)
    return json.loads(INDEX_FILE.read_text(encoding="utf-8"))


def cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    a, b = np.array(a), np.array(b)
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return dot / norm if norm > 0 else 0.0


def keyword_search(chunks: list[dict], terms: list[str]) -> dict[int, dict]:
    """Search chunks for exact keyword matches. Returns {chunk_id: {term: count}}."""
    results = {}
    for chunk in chunks:
        text_lower = chunk["text"].lower()
        hits = {}
        for term in terms:
            count = text_lower.count(term.lower())
            if count > 0:
                hits[term] = count
        if hits:
            results[chunk["id"]] = hits
    return results


def vector_search(client: OpenAI, chunks: list[dict], terms: list[str], model: str) -> dict[int, float]:
    """Embed search terms and find most similar chunks. Returns {chunk_id: max_similarity}."""
    # Embed all terms in one call
    resp = client.embeddings.create(model=model, input=terms)
    query_embeddings = [item.embedding for item in resp.data]

    # Compute similarities
    scores = {}
    for chunk in chunks:
        if "embedding" not in chunk:
            continue
        max_sim = 0.0
        for qe in query_embeddings:
            sim = cosine_similarity(qe, chunk["embedding"])
            max_sim = max(max_sim, sim)
        scores[chunk["id"]] = max_sim

    return scores


def merge_results(chunks: list[dict], keyword_hits: dict, vector_scores: dict, top_n: int) -> list[dict]:
    """Merge keyword and vector results into a ranked list."""
    chunk_map = {c["id"]: c for c in chunks}
    all_ids = set(keyword_hits.keys()) | set(vector_scores.keys())

    scored = []
    for cid in all_ids:
        chunk = chunk_map[cid]
        kw = keyword_hits.get(cid, {})
        vs = vector_scores.get(cid, 0.0)
        kw_total = sum(kw.values())

        # Skip tiny chunks (headers, empty sections)
        if len(chunk["text"].strip()) < 50:
            continue

        # Skip low-quality matches: weak semantics AND few keyword hits
        if vs < 0.25 and kw_total < 3:
            continue

        # Multiplicative merge: keywords amplify semantic relevance
        # rather than replacing it. A keyword hit in an irrelevant chunk
        # stays low; a keyword hit in a relevant chunk gets boosted.
        if vs > 0:
            combined = vs * (1.0 + 0.15 * min(kw_total, 5))
        else:
            # Pure keyword match (no vector search or no embedding) — reduced score
            combined = 0.05 * min(kw_total, 5)

        scored.append({
            "chunk": chunk,
            "keyword_hits": kw,
            "semantic_score": vs,
            "combined_score": combined,
        })

    scored.sort(key=lambda x: x["combined_score"], reverse=True)
    return scored[:top_n]


def format_output(results: list[dict]) -> str:
    """Format results as structured text for Claude."""
    if not results:
        return "=== KB SEARCH RESULTS ===\n\nNo results found."

    lines = ["=== KB SEARCH RESULTS ===\n"]

    # Summary table
    lines.append("## Summary")
    lines.append("| File | Section | Keyword Hits | Semantic Score |")
    lines.append("|------|---------|-------------|----------------|")
    for r in results:
        c = r["chunk"]
        kw_str = ", ".join(f"{t}({n})" for t, n in r["keyword_hits"].items()) if r["keyword_hits"] else ""
        lines.append(f"| {c['file']} | {c['section']} | {kw_str} | {r['semantic_score']:.2f} |")

    lines.append("\n## Top Chunks\n")

    # Detailed chunks
    for i, r in enumerate(results, 1):
        c = r["chunk"]
        kw_part = ""
        if r["keyword_hits"]:
            kw_parts = [f"{t}\u00d7{n}" for t, n in r["keyword_hits"].items()]
            kw_part = f"keyword: {', '.join(kw_parts)}, "
        header = f"[{i}] {c['file']} \u00a7{c['section']} [L{c['line_start']}-L{c['line_end']}] ({kw_part}semantic: {r['semantic_score']:.2f})"
        lines.append(header)

        # Show chunk text, truncated to ~500 chars
        text = c["text"]
        if len(text) > 500:
            text = text[:500] + "..."
        # Indent as blockquote
        for tl in text.split("\n")[:10]:
            lines.append(f"> {tl}")
        lines.append("")

    # Files to consider
    files_seen = []
    for r in results:
        f = r["chunk"]["file"]
        if f not in files_seen:
            files_seen.append(f)
    lines.append(f"---\nFiles to consider reading in full: {', '.join(files_seen)}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Search the David OS knowledge base")
    parser.add_argument("terms", nargs="*", help="Search terms (keywords or phrases)")
    parser.add_argument("--top", type=int, default=10, help="Number of results (default: 10)")
    parser.add_argument("--keyword-only", action="store_true", help="Skip vector search")
    parser.add_argument("--reindex", action="store_true", help="Rebuild index before searching")
    args = parser.parse_args()

    if not args.terms:
        parser.print_help()
        sys.exit(1)

    # Reindex if requested
    if args.reindex:
        print("Re-indexing...", file=sys.stderr)
        subprocess.run(
            [sys.executable, str(ROOT / "tools" / "kb_index.py")],
            check=True,
        )
        print("", file=sys.stderr)

    index = load_index()
    chunks = index["chunks"]

    # Keyword search
    keyword_hits = keyword_search(chunks, args.terms)

    # Vector search
    vector_scores = {}
    if not args.keyword_only:
        client = OpenAI()
        vector_scores = vector_search(client, chunks, args.terms, index["model"])

    # Merge and rank
    results = merge_results(chunks, keyword_hits, vector_scores, args.top)

    # Output
    print(format_output(results))


if __name__ == "__main__":
    main()
