# David OS — Personal Operating System

## How This System Works
David's personal knowledge base and life operating system. The AI assistant organizes, retrieves, and builds on information across all life areas — functioning as an always-on system that keeps David's world structured, up-to-date, and useful.

**Context architecture:**
- This root CLAUDE.md is auto-loaded every conversation → keep it lean, only essentials
- `recent.md` — rolling recent memory. **Read at the start of every conversation.** Updated after every message. Old/irrelevant items get removed to keep it fresh.
- Area folders contain topic-specific files → read on demand when relevant
- Each area folder has an `_index.md` entry-point summarizing contents and linking to detail files
- Detail files hold specific content → loaded only when needed

**Retrieval protocol (mandatory for every non-trivial message):**
1. **Extract concepts** — from the user's message, identify: proper nouns (Tom, PetRadar), topic words (business, fitness, travel), emotional/state words (depleted, anxious, motivated), and any specific terms. Aim for 3-7 search terms.
2. **Run kb-search** — `./kb-search "term1" "term2" "term3"`
3. **Review results** — look at the summary table and top chunks
4. **Read relevant files** — any file with high relevance in the results gets read in full
5. **For complex queries** — spawn sub-agents per topic cluster to compile focused briefs
6. **Verify before answering** — check: "am I using everything I know? Would this answer change if I loaded one more file?" If yes, go load it.

After responding, if new information was shared:
7. **Update markdown files** — apply the granular processing rules
8. **Re-index** — `./kb-index` (only needed if files were modified)

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
