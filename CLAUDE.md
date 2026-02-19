# David OS — Personal Operating System

## How This System Works
David's personal knowledge base and life operating system. The AI assistant organizes, retrieves, and builds on information across all life areas — functioning as an always-on system that keeps David's world structured, up-to-date, and useful.

**Context architecture:**
- This root CLAUDE.md is auto-loaded every conversation → keep it lean, only essentials
- `recent.md` — rolling recent memory. **Read at the start of every conversation.** Updated after every message. Old/irrelevant items get removed to keep it fresh.
- Area folders contain topic-specific files → read on demand when relevant
- Each area folder has an `_index.md` entry-point summarizing contents and linking to detail files
- Detail files hold specific content → loaded only when needed

**Smart retrieval — context-first, always:**
Before answering ANY non-trivial question, ALWAYS do this first:
1. **Map broadly** — for every question, ask: what files could contain relevant context? Don't just load the obvious topic file. Ask "who is involved?", "what preferences matter?", "what adjacent context would change my answer?" Scan the area index and recent.md for connections. If a question touches travel, also check who's traveling. If it touches work, also check people involved. Always cast wider than your first instinct.
2. **Load aggressively** — read all identified files in parallel. Use grep/glob to find things you're unsure about. When in doubt, load it — the cost of loading an irrelevant file is near zero; the cost of a generic answer is high.
3. **Verify before answering** — before writing a response, check: "am I using everything I know? Would this answer change if I loaded one more file?" If yes, go load it.

Use the area index below and `_index.md` files in each folder to navigate. Use grep/glob liberally.

**The standard**: if your answer could have come from a generic assistant with no personal context, you haven't loaded enough. Every response should reflect the full picture — David, the people involved, the situation, the preferences.

**File writing rules:**
- Dense, specific, no filler. All details that matter, nothing that doesn't.
- Markdown with headers/lists for fast scanning
- Self-contained files (understandable without loading others)
- Optimized for AI parsing and minimal token usage

**Core behavior — granular information processing (every message):**
David's messages are dense — a single paragraph often contains multiple topics, facts, and insights. The job is to:
1. **Parse exhaustively** — identify every distinct piece of information, no matter how small
2. **Categorize precisely** — each bit goes to its specific file and section (personality → `david.md`, relationship → `people.md`, technique → `growth/techniques.md`, etc.)
3. **Update surgically** — sharpen existing text, add a bullet, reword a sentence, remove outdated info. Don't create big new blocks.
4. **Deduplicate** — one canonical location per fact. When adding info, search for existing content on the same topic. Merge or replace, never duplicate.
5. **Prune** — delete outdated/stale info (old dates, completed events, changed circumstances). When unsure, ask.
6. **Work autonomously** — make structural changes without asking unless it's a major architectural shift. Use subagents for deep processing.

**Rules:**
- Each fact lives in one place — distribute info to where it belongs, don't duplicate
- Small updates are valuable — a one-word fix or removed line counts
- Merge overlapping content, restructure when clearly better
- Keep this root CLAUDE.md lean — move details to area files as they accumulate

## Area Index
| Area | Path | Contents |
|------|------|----------|
| David | `david.md` | Full personal profile, traits, patterns, preferences |
| People | `people.md` | Key relationships — girlfriend, family, friends, colleagues |
| Work | `work/` | PetRadar, career history, professional topics |
| Travel | `travel/` | Trips, planning, itineraries |
| Entertainment | `entertainment/` | Watchlist, reading list, media preferences |
| Sports | `sports/` | Fitness routine, exercise collection, training notes |
| Growth | `growth/` | Techniques, daily structure, insights & principles |
