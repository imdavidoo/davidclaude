"""Output recent daily entries from the recent/ directory, newest first."""

import os
import sys
from datetime import date, timedelta

def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    recent_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "recent")

    if not os.path.isdir(recent_dir):
        print("No recent/ directory found.", file=sys.stderr)
        sys.exit(1)

    cutoff = date.today() - timedelta(days=days)
    entries = []

    for fname in os.listdir(recent_dir):
        if fname.startswith("_") or not fname.endswith(".md"):
            continue
        stem = fname[:-3]  # strip .md
        try:
            file_date = date.fromisoformat(stem)
        except ValueError:
            continue
        if file_date >= cutoff:
            entries.append((file_date, os.path.join(recent_dir, fname)))

    entries.sort(key=lambda x: x[0], reverse=True)

    for i, (file_date, filepath) in enumerate(entries):
        if i > 0:
            print("\n---\n")
        with open(filepath, "r") as f:
            print(f.read().rstrip())


if __name__ == "__main__":
    main()
