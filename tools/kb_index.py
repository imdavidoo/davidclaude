#!/usr/bin/env python3
"""KB Indexer — chunks markdown files, embeds via OpenAI, stores in .kb-index/index.json."""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

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
INDEX_DIR = ROOT / ".kb-index"
INDEX_FILE = INDEX_DIR / "index.json"
EMBEDDING_MODEL = "text-embedding-3-small"
SKIP_FILES = {"CLAUDE.md"}
BATCH_SIZE = 50  # max chunks per embedding API call


def find_md_files():
    """Find all .md files in the knowledge base, excluding SKIP_FILES."""
    files = []
    for p in sorted(ROOT.rglob("*.md")):
        rel = p.relative_to(ROOT)
        # Skip files in tools/, .venv/, .kb-index/
        parts = rel.parts
        if any(part.startswith(".") for part in parts):
            continue
        if parts[0] in ("tools", "node_modules", "telegram-bot"):
            continue
        if rel.name in SKIP_FILES:
            continue
        files.append(rel)
    return files


def file_hash(path: Path) -> str:
    """SHA256 hash of file contents."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def chunk_file(rel_path: Path) -> list[dict]:
    """Split a markdown file into chunks by H2 headers."""
    full_path = ROOT / rel_path
    text = full_path.read_text(encoding="utf-8")
    lines = text.split("\n")

    chunks = []
    current_section = None
    current_lines = []
    current_start = 1  # 1-indexed

    def flush():
        if current_lines:
            content = "\n".join(current_lines).strip()
            if content:
                chunks.append({
                    "file": str(rel_path),
                    "section": current_section or "(top)",
                    "line_start": current_start,
                    "line_end": current_start + len(current_lines) - 1,
                    "text": content,
                })

    for i, line in enumerate(lines):
        if re.match(r"^## ", line):
            flush()
            current_section = line.lstrip("# ").strip()
            current_lines = [line]
            current_start = i + 1
        else:
            current_lines.append(line)

    flush()

    # If no chunks were created (no H2 headers), treat whole file as one chunk
    if not chunks:
        content = text.strip()
        if content:
            chunks.append({
                "file": str(rel_path),
                "section": "(full file)",
                "line_start": 1,
                "line_end": len(lines),
                "text": content,
            })

    return chunks


def embed_texts(client: OpenAI, texts: list[str]) -> list[list[float]]:
    """Embed a list of texts in batches."""
    all_embeddings = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        resp = client.embeddings.create(model=EMBEDDING_MODEL, input=batch)
        for item in resp.data:
            all_embeddings.append(item.embedding)
    return all_embeddings


def load_existing_index() -> dict | None:
    """Load the existing index if it exists."""
    if INDEX_FILE.exists():
        try:
            return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, KeyError):
            return None
    return None


def build_index():
    """Build or incrementally update the index."""
    client = OpenAI()  # reads OPENAI_API_KEY from env

    md_files = find_md_files()
    print(f"Found {len(md_files)} markdown files")

    # Load existing index for incremental updates
    existing = load_existing_index()
    old_hashes = existing["file_hashes"] if existing else {}
    old_chunks = {(c["file"], c["section"]): c for c in existing["chunks"]} if existing else {}

    # Compute current hashes
    current_hashes = {}
    for rel in md_files:
        current_hashes[str(rel)] = file_hash(ROOT / rel)

    # Determine which files changed
    changed_files = set()
    for f, h in current_hashes.items():
        if old_hashes.get(f) != h:
            changed_files.add(f)

    # Also detect deleted files
    deleted_files = set(old_hashes.keys()) - set(current_hashes.keys())

    if not changed_files and not deleted_files:
        print("No files changed — index is up to date.")
        return

    print(f"Changed files: {sorted(changed_files) if changed_files else 'none'}")
    if deleted_files:
        print(f"Deleted files: {sorted(deleted_files)}")

    # Build chunks: keep old chunks for unchanged files, re-chunk changed files
    all_chunks = []
    new_chunks_to_embed = []

    for rel in md_files:
        f = str(rel)
        if f in changed_files:
            chunks = chunk_file(rel)
            for c in chunks:
                new_chunks_to_embed.append(c)
                all_chunks.append(c)
        else:
            # Reuse old chunks for this file
            for c in (existing["chunks"] if existing else []):
                if c["file"] == f:
                    all_chunks.append(c)

    print(f"Total chunks: {len(all_chunks)} ({len(new_chunks_to_embed)} need embedding)")

    # Embed new chunks
    if new_chunks_to_embed:
        texts = [c["text"] for c in new_chunks_to_embed]
        print(f"Embedding {len(texts)} chunks...")
        embeddings = embed_texts(client, texts)
        for c, emb in zip(new_chunks_to_embed, embeddings):
            c["embedding"] = emb

    # Assign IDs
    for i, c in enumerate(all_chunks):
        c["id"] = i

    # Write index
    INDEX_DIR.mkdir(exist_ok=True)
    index_data = {
        "model": EMBEDDING_MODEL,
        "indexed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "file_hashes": current_hashes,
        "chunks": all_chunks,
    }
    INDEX_FILE.write_text(json.dumps(index_data), encoding="utf-8")
    print(f"Index written to {INDEX_FILE} ({len(all_chunks)} chunks)")


if __name__ == "__main__":
    build_index()
