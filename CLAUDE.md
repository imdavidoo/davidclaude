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

Daily 17:00 NL (bot-internal timer) or `#sculptor` in Telegram. Analyzes KB, streams progress, David replies to approve changes. Config: `sculptor-prompt.md`.

## Key tools

- `./kb-search "term1" "term2"` — hybrid vector + keyword search. Related terms in one search boost each other; separate topics need separate searches.
- `./kb-index` — re-indexes all .md files after changes.
- `./notify "message"` — sends a Telegram notification to David.
