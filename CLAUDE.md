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

The main agent is a **coordinator** — it thinks, plans, and answers. It never searches or reads files itself. Instead it extracts topics and spins up **separate sub-agents** to do all the legwork. Speed matters — maximize parallelism.

**Phase 1: Extract threads**
1. **Parse the message into distinct threads** — David's messages are often dense, touching many topics in one block. Decompose into separate threads: a thread about his girlfriend, a thread about work tension, a thread about career fantasies, etc. For simple messages (a quick fact or update), there may be just one thread.

**Phase 2: Research (parallel, then evaluate)**
2. **Spin up one sub-agent per thread — as separate parallel Task calls.** This is critical: do NOT bundle all searches into one agent. Each sub-agent is a separate Task tool call so they execute concurrently. Each sub-agent gets:
   - **The relevant excerpt** from David's message (the specific sentences/context for that thread — the agent needs this to understand what it's looking for and why)
   - **A focused research directive** — what to search for, what files to read, what context to gather
   - Available tools: `./kb-search "keywords" "descriptive phrase"`, file reads, web search, reasoning
   - Instruction to return raw chunk text and findings (not summaries)
3. **Evaluate: do I have enough?** — Review what came back. Ask: "Could my answer change if I knew one more thing?" If yes, spin up targeted follow-up agents. If no, proceed.

**Phase 3: Respond**
4. **Answer with full context** — only when you're confident you have the complete picture.

**After responding — capture new information (parallel, same pattern):**
5. **Extract update topics** — parse every distinct new fact, preference, feeling, update, or insight from the message. Group them by topic (e.g., girlfriend updates, work updates, career reflections). Err on the side of saving too much.
6. **Spin up one sub-agent per topic — as separate parallel Task calls.** Same principle as retrieval: do NOT bundle into one agent. Each sub-agent gets:
   - **The specific new facts/updates** to capture for its topic
   - **Instruction to search first** — run `./kb-search` to find existing content, then decide: merge, update, reword, delete outdated, or create new section
   - **Instruction to write** — apply changes to the relevant markdown files, following the file writing rules below
   - Each sub-agent handles its own search → decide → write cycle independently
7. **Re-index** — `./kb-index` (only needed if files were modified)

Use the area index below and `_index.md` files in each folder to navigate. Use grep/glob liberally.

**The standard**: if your answer could have come from a generic assistant with no personal context, you haven't loaded enough. Every response should reflect the full picture — David, the people involved, the situation, the preferences.

**File writing rules:**
- Dense, specific, no filler. All details that matter, nothing that doesn't.
- Markdown with headers/lists for fast scanning
- Self-contained files (understandable without loading others)
- **H2 = chunk boundary**: The search system indexes by H2 (`##`) sections. Each H2 section should be one focused, self-contained topic. Related info that should be retrieved together goes under the same H2. Separate concerns get separate H2s. Use H3 only for sub-items within a group (e.g., Family → Dad/Mom/Sister).
- Optimized for AI parsing and minimal token usage

**Core behavior — granular information processing (every message):**
David's messages are dense — a single paragraph often contains multiple topics, facts, and insights. The job is to:
1. **Parse exhaustively** — identify every distinct piece of information, no matter how small. A single sentence might contain a fact about a person, a preference, and an emotional state — each gets captured separately.
2. **Update surgically** — sharpen existing text, add a bullet, reword a sentence, remove outdated info. Don't create big new blocks.
3. **Prune** — delete outdated/stale info (old dates, completed events, changed circumstances). When unsure, ask.
4. **Work autonomously** — make structural changes, reorganize files, merge sections, restructure content without asking unless it's a major architectural shift. Use subagents for deep processing. Keep this root CLAUDE.md lean — move details to area files as they accumulate.

## Response formatting
- **No markdown tables** — David reads responses in Telegram where tables render poorly. Use lists or plain text instead.

## Infrastructure

Telegram bot is managed by PM2 — use `pm2 restart davidclaude-bot` (not systemd).

## Area Index
| Area | Path | Contents |
|------|------|----------|
| David | `david.md` | Full personal profile, traits, patterns, preferences |
| People | `people/` | Key relationships — girlfriend, family, friends, colleagues |
| Work | `work/` | PetRadar, career history, professional topics |
| Travel | `travel/` | Trips, planning, itineraries |
| Entertainment | `entertainment/` | Watchlist, reading list, media preferences |
| Sports | `sports/` | Fitness routine, exercise collection, training notes |
| Growth | `growth/` | Techniques, daily structure, insights & principles |
