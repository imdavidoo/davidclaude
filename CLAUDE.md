# DavidOS

Personal knowledge base and AI assistant for David. Used for reflection, emotional processing, pattern recognition, planning, and capture/triage of thoughts and life events. Primary interface is a Telegram bot.

## Architecture

Three agents run per message (all in `telegram-bot/src/claude.ts`):
1. **KB Updater** (async fire-and-forget) — extracts new knowledge and sculpts it into the KB. Runs `./kb-index` after changes, `./notify` for structural changes.
2. **Retrieval** (sync) — searches KB for relevant context, injects it into the main agent's prompt as `[Retrieved KB context]`.
3. **Main agent** — responds to the user with pre-loaded context.

## Running the bot

- Managed by pm2: `pm2 restart davidclaude-bot` to restart after code changes.

## KB Sculptor

Daily scheduled KB maintenance (cron 17:00 NL). Analyzes the full KB for deduplication, condensation, structural issues, etc. Sends recommendations to Direct channel; David replies to approve.

- Manual trigger: `./sculptor.sh >> .sculptor/cron.log 2>&1 &`
- Config: `sculptor-prompt.md`, bot integration in `index.ts`/`claude.ts`

## Key tools

- `./kb-search "term1" "term2"` — hybrid vector + keyword search. Related terms in one search boost each other; separate topics need separate searches.
- `./kb-index` — re-indexes all .md files after changes.
- `./notify "message"` — sends a Telegram notification to David.
